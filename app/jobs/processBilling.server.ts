// app/jobs/processBilling.server.ts

import db from "../db.server";

const BILLING_MUTATION = `#graphql
  mutation subscriptionBillingAttemptCreate(
    $subscriptionContractId: ID!
    $originTime: DateTime
  ) {
    subscriptionBillingAttemptCreate(
      subscriptionContractId: $subscriptionContractId
      subscriptionBillingAttemptInput: { originTime: $originTime }
    ) {
      subscriptionBillingAttempt {
        id
        ready
        errorMessage
        errorCode
      }
      userErrors { field message }
    }
  }
`;

// Matches the type that admin.graphql returns in @shopify/shopify-app-remix
type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> }
) => Promise<Response>;

export async function processDueBillingAttempts(
  shop: string,
  adminGraphql: AdminGraphql,
) {
  const now = new Date();

  // ── Only fetch ACTIVE subscriptions that are due ──────────
  // PAUSED and CANCELLED never reach this query at all
  const dueSubs = await db.subscription.findMany({
    where: {
      shop,
      status: "ACTIVE",
      nextBillingDate: { lte: now },
    },
  });

  if (dueSubs.length === 0) {
    console.log(`[billing:cron] No due subscriptions for ${shop}`);
    return { attempted: 0, skipped: 0 };
  }

  console.log(`[billing:cron] ${dueSubs.length} due for ${shop}`);

  let attempted = 0;
  let skipped   = 0;

  for (const sub of dueSubs) {
    // ── Re-fetch right before billing (race condition guard) ─
    // Catches a pause/cancel that happened mid-loop
    const fresh = await db.subscription.findUnique({ where: { id: sub.id } });

    if (!fresh || fresh.status !== "ACTIVE") {
      console.log(`[billing:cron] Skipping ${sub.id} — status is now ${fresh?.status ?? "deleted"}`);
      skipped++;
      continue;
    }

    try {
      const res    = await adminGraphql(BILLING_MUTATION, {
        variables: {
          subscriptionContractId: fresh.shopifyContractId,
          originTime: fresh.nextBillingDate.toISOString(),
        },
      });
      const result = await res.json();

      const payload    = result?.data?.subscriptionBillingAttemptCreate;
      const userErrors = payload?.userErrors ?? [];

      if (userErrors.length) {
        const msg = userErrors.map((e: any) => e.message).join(" | ");
        console.error(`[billing:cron] userErrors for ${sub.id}:`, msg);
        await db.billingAttempt.create({
          data: { subscriptionId: sub.id, amount: fresh.price, status: "FAILED", errorMessage: msg },
        });
        await db.subscription.update({
          where: { id: sub.id },
          data:  { status: "FAILED" },
        });
        continue;
      }

      const attempt      = payload?.subscriptionBillingAttempt;
      const success      = attempt?.ready === true && !attempt?.errorCode;
      const errorMessage = attempt?.errorMessage ?? attempt?.errorCode ?? null;

      // Record billing attempt
      await db.billingAttempt.create({
        data: {
          subscriptionId: sub.id,
          amount:         fresh.price,
          status:         success ? "SUCCESS" : "FAILED",
          errorMessage,
        },
      });

      if (success) {
        // Advance next billing date
        await db.subscription.update({
          where: { id: sub.id },
          data:  { nextBillingDate: nextDate(fresh.nextBillingDate, fresh.frequency) },
        });
        console.log(`[billing:cron] SUCCESS ${sub.id} — next: ${nextDate(fresh.nextBillingDate, fresh.frequency)}`);
      } else {
        // Mark as FAILED so detail page shows the warning banner
        await db.subscription.update({
          where: { id: sub.id },
          data:  { status: "FAILED" },
        });
        console.error(`[billing:cron] FAILED ${sub.id}:`, errorMessage);
      }

      attempted++;
    } catch (err: any) {
      console.error(`[billing:cron] Exception for ${sub.id}:`, err?.message);
      await db.billingAttempt.create({
        data: {
          subscriptionId: sub.id,
          amount:         fresh.price,
          status:         "FAILED",
          errorMessage:   err?.message ?? "Unknown error",
        },
      });
    }
  }

  console.log(`[billing:cron] Done — attempted: ${attempted}, skipped: ${skipped}`);
  return { attempted, skipped };
}

// ─── Next billing date helper ─────────────────────────────────
function nextDate(from: Date, frequency: string): Date {
  const d = new Date(from);
  const f = frequency.toUpperCase();
  if (f.includes("WEEK"))  { d.setDate(d.getDate() + 7);        return d; }
  if (f.includes("YEAR"))  { d.setFullYear(d.getFullYear() + 1); return d; }
  d.setMonth(d.getMonth() + 1); // default: monthly
  return d;
}
