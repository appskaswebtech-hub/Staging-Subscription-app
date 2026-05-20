// app/routes/app.subscriptions.$id.tsx

import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useSubmit,
  useNavigation,
  useActionData,
} from "@remix-run/react";
import {
  Page,
  BlockStack,
  InlineStack,
  Text,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server"; // ← FIXED: was `prisma`

// ─── GID helper ──────────────────────────────────────────────
function toFullGid(raw: string): string {
  if (raw.startsWith("gid://")) return raw;
  if (raw.includes("/")) return `gid://shopify/${raw}`;
  return `gid://shopify/SubscriptionContract/${raw}`;
}

// ─── Mutations ───────────────────────────────────────────────
const PAUSE_MUTATION = `
  mutation subscriptionContractPause($subscriptionContractId: ID!) {
    subscriptionContractPause(subscriptionContractId: $subscriptionContractId) {
      contract { id status }
      userErrors { field message }
    }
  }
`;

const ACTIVATE_MUTATION = `
  mutation subscriptionContractActivate($subscriptionContractId: ID!) {
    subscriptionContractActivate(subscriptionContractId: $subscriptionContractId) {
      contract { id status }
      userErrors { field message }
    }
  }
`;

const CANCEL_MUTATION = `
  mutation subscriptionContractCancel($subscriptionContractId: ID!) {
    subscriptionContractCancel(subscriptionContractId: $subscriptionContractId) {
      contract { id status }
      userErrors { field message }
    }
  }
`;

const OPERATIONS = {
  pause:  { mutation: PAUSE_MUTATION,    payloadKey: "subscriptionContractPause",    localStatus: "PAUSED"    },
  resume: { mutation: ACTIVATE_MUTATION, payloadKey: "subscriptionContractActivate", localStatus: "ACTIVE"    },
  cancel: { mutation: CANCEL_MUTATION,   payloadKey: "subscriptionContractCancel",   localStatus: "CANCELLED" },
} as const;

type Intent = keyof typeof OPERATIONS;

// ─── Design tokens ───────────────────────────────────────────
const T = {
  purple:     "#7F77DD",
  purpleBg:   "#EEEDFE",
  purpleDark: "#26215C",
  purpleFg:   "#3C3489",
  greenBg:    "#EAF3DE",
  greenFg:    "#27500A",
  greenDot:   "#3B6D11",
  amberBg:    "#FAEEDA",
  amberFg:    "#633806",
  redBg:      "#FCEBEB",
  redFg:      "#791F1F",
  redBorder:  "#F09595",
};

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const subscription = await db.subscription.findFirst({ // ← FIXED
    where:   { id: params.id, shop: session.shop },
    include: { billingAttempts: { orderBy: { createdAt: "desc" }, take: 50 } },
  });

  if (!subscription) throw new Response("Not found", { status: 404 });
  return json({ subscription });
}

// ─── Action ───────────────────────────────────────────────────
export async function action({ request, params }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const formData           = await request.formData();
  const intent             = formData.get("intent") as Intent;

  if (!OPERATIONS[intent])
    return json({ error: `Unknown intent: ${intent}` }, { status: 400 });

  const sub = await db.subscription.findFirst({ // ← FIXED
    where: { id: params.id, shop: session.shop },
  });

  if (!sub) throw new Response("Not found", { status: 404 });

  const contractGid = toFullGid(sub.shopifyContractId);

  console.log(`[${intent}] GID: ${contractGid} | current status: ${sub.status}`);

  // ── FIXED: PAUSED → CANCEL requires activate first ────────
  // Shopify rejects subscriptionContractCancel on a PAUSED contract.
  // Must resume it first, then cancel.
  if (intent === "cancel" && sub.status === "PAUSED") {
    console.log(`[cancel] Contract is PAUSED — activating first`);
    try {
      const activateRes    = await admin.graphql(ACTIVATE_MUTATION, {
        variables: { subscriptionContractId: contractGid },
      });
      const activateResult = await activateRes.json();
      const activateErrors = activateResult?.data?.subscriptionContractActivate?.userErrors ?? [];

      if (activateErrors.length) {
        const msg = activateErrors.map((e: any) => e.message).join(" | ");
        console.error(`[cancel] Pre-activate failed:`, msg);
        return json({ error: `Could not activate before cancel: ${msg}` });
      }
      console.log(`[cancel] Pre-activate succeeded`);
    } catch (err: any) {
      return json({ error: `Pre-activate request failed: ${err?.message}` });
    }
  }

  // ── Already in target state — skip redundant Shopify call ─
  const targetStatus: Record<Intent, string> = {
    pause:  "PAUSED",
    resume: "ACTIVE",
    cancel: "CANCELLED",
  };
  if (sub.status === targetStatus[intent]) {
    console.log(`[${intent}] Already ${sub.status} — skipping`);
    return redirect(`/app/subscriptions`);
  }

  const op = OPERATIONS[intent];

  let result: any;
  try {
    const res = await admin.graphql(op.mutation, {
      variables: { subscriptionContractId: contractGid },
    });
    result = await res.json();
  } catch (err: any) {
    console.error(`[${intent}] GraphQL threw:`, err?.message);
    return json({ error: `GraphQL request failed: ${err?.message}` });
  }

  console.log(`[${intent}] Raw response:`, JSON.stringify(result, null, 2));

  // Top-level GraphQL errors (wrong API version, auth, syntax)
  if (result?.errors?.length) {
    const msg = result.errors.map((e: any) => e.message).join(" | ");
    console.error(`[${intent}] Top-level errors:`, msg);
    return json({ error: `Shopify error: ${msg}` });
  }

  const payload = result?.data?.[op.payloadKey];

  // Null payload = mutation not found / missing scope
  if (!payload) {
    const msg = `No payload for "${op.payloadKey}". Check api_version (needs 2024-04+) and write_own_subscription_contracts scope.`;
    console.error(`[${intent}]`, msg);
    return json({ error: msg });
  }

  const userErrors = (payload?.userErrors ?? []) as Array<{ field: string[]; message: string }>;
  if (userErrors.length > 0) {
    const msg = userErrors
      .map((e) => `[${e.field?.join(".") ?? "field"}] ${e.message}`)
      .join(" | ");
    console.error(`[${intent}] userErrors:`, msg);
    return json({ error: msg });
  }

  // ── FIXED: use Shopify's confirmed status, fall back to localStatus ──
  const confirmedStatus = payload?.contract?.status ?? op.localStatus;
  console.log(`[${intent}] Shopify confirmed status: ${confirmedStatus}`);

  await db.subscription.update({ // ← FIXED
    where: { id: params.id! },
    data:  { status: confirmedStatus },
  });

  return redirect(`/app/subscriptions`);
}

// ─── Helpers ─────────────────────────────────────────────────
function statusPill(status: string) {
  const styles: Record<string, { bg: string; color: string; dot: string }> = {
    ACTIVE:    { bg: T.greenBg, color: T.greenFg, dot: T.greenDot },
    PAUSED:    { bg: T.amberBg, color: T.amberFg, dot: "#BA7517"  },
    CANCELLED: { bg: T.redBg,   color: T.redFg,   dot: "#E24B4A"  },
    FAILED:    { bg: T.redBg,   color: T.redFg,   dot: "#E24B4A"  },
    PENDING:   { bg: T.purpleBg,color: T.purpleFg,dot: T.purple   },
  };
  const s = styles[status] ?? styles.PENDING;
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: "5px",
        fontSize: "12px", fontWeight: 500,
        padding: "4px 12px", background: s.bg, color: s.color,
        borderRadius: "20px",
      }}
    >
      <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: s.dot, display: "inline-block" }} />
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function fmt(date: string | Date) {
  return new Date(date).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" });
}

function fmtDateTime(date: string | Date) {
  return new Date(date).toLocaleString("en-GB", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// ─── Detail row ──────────────────────────────────────────────
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "0.5px solid var(--p-color-border-secondary)" }}>
      <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
      <div style={{ textAlign: "right" }}>{children}</div>
    </div>
  );
}

function DetailRowLast({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0" }}>
      <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
      <div style={{ textAlign: "right" }}>{children}</div>
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "var(--p-color-bg-surface)", border: "0.5px solid var(--p-color-border)", borderRadius: "14px", overflow: "hidden" }}>
      <div style={{ padding: "16px 20px", borderBottom: "0.5px solid var(--p-color-border)" }}>
        <Text as="h2" variant="headingMd" fontWeight="bold">{title}</Text>
      </div>
      <div style={{ padding: "4px 20px 6px" }}>{children}</div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────
export default function SubscriptionDetail() {
  const { subscription } = useLoaderData<typeof loader>();
  const actionData        = useActionData<typeof action>();
  const submit            = useSubmit();
  const navigation        = useNavigation();

  const isSubmitting = navigation.state === "submitting";
  const activeIntent = navigation.formData?.get("intent") as string | undefined;
  const s            = subscription;

  function doAction(intent: Intent) {
    const fd = new FormData();
    fd.append("intent", intent);
    submit(fd, { method: "post" });
  }

  const canResume = s.status === "PAUSED" || s.status === "FAILED";
  const canPause  = s.status === "ACTIVE";
  const canCancel = s.status !== "CANCELLED";

  const shopifyAdminUrl = `https://${s.shop}/admin/subscriptions/${s.shopifyContractId.split("/").pop()}`;

  const successAttempts = s.billingAttempts.filter((a) => a.status === "SUCCESS");
  const failedAttempts  = s.billingAttempts.filter((a) => a.status === "FAILED");
  const totalCollected  = successAttempts.reduce((sum, a) => sum + a.amount, 0);

  return (
    <Page>
      <TitleBar title={s.productTitle} />

      <BlockStack gap="600">

        {/* ── Page header ─────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
          <BlockStack gap="100">
            <InlineStack gap="150" blockAlign="center">
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: T.purple, display: "inline-block" }} />
              <Text as="span" variant="bodySm" tone="subdued">KAS Subscription › Subscriptions › Detail</Text>
            </InlineStack>
            <InlineStack gap="300" blockAlign="center">
              <Text as="h1" variant="headingXl" fontWeight="bold">{s.productTitle}</Text>
              {statusPill(s.status)}
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              Contract #{s.shopifyContractId.split("/").pop()} · {s.customerEmail}
            </Text>
          </BlockStack>

          {/* Action buttons */}
          <InlineStack gap="200" blockAlign="center">
            {canResume && (
              <button
                onClick={() => doAction("resume")}
                disabled={isSubmitting}
                style={{ background: T.purpleDark, color: T.purpleBg, border: "none", padding: "9px 18px", borderRadius: "10px", fontSize: "13px", fontWeight: 500, cursor: "pointer", opacity: isSubmitting && activeIntent === "resume" ? 0.7 : 1 }}
              >
                {isSubmitting && activeIntent === "resume" ? "Resuming…" : "Resume subscription"}
              </button>
            )}
            {canPause && (
              <button
                onClick={() => doAction("pause")}
                disabled={isSubmitting}
                style={{ background: T.amberBg, color: T.amberFg, border: "0.5px solid #EF9F27", padding: "9px 18px", borderRadius: "10px", fontSize: "13px", fontWeight: 500, cursor: "pointer", opacity: isSubmitting && activeIntent === "pause" ? 0.7 : 1 }}
              >
                {isSubmitting && activeIntent === "pause" ? "Pausing…" : "Pause subscription"}
              </button>
            )}
            {canCancel && (
              <button
                onClick={() => { if (window.confirm("Permanently cancel this subscription? This cannot be undone.")) doAction("cancel"); }}
                disabled={isSubmitting}
                style={{ background: "var(--p-color-bg-surface)", color: T.redFg, border: `0.5px solid ${T.redBorder}`, padding: "9px 16px", borderRadius: "10px", fontSize: "13px", cursor: "pointer", opacity: isSubmitting && activeIntent === "cancel" ? 0.7 : 1 }}
              >
                {isSubmitting && activeIntent === "cancel" ? "Cancelling…" : "Cancel"}
              </button>
            )}
            <button
              onClick={() => window.open(shopifyAdminUrl, "_blank")}
              style={{ background: "var(--p-color-bg-surface)", color: "var(--p-color-text-subdued)", border: "0.5px solid var(--p-color-border-secondary)", padding: "9px 14px", borderRadius: "10px", fontSize: "13px", cursor: "pointer" }}
            >
              Shopify Admin ↗
            </button>
          </InlineStack>
        </div>

        {/* ── Banners ───────────────────────────────────── */}
        {actionData && "error" in actionData && (
          <Banner tone="critical" title="Action failed">
            <BlockStack gap="100">
              <Text as="p">{(actionData as any).error}</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Common causes: missing <strong>write_own_subscription_contracts</strong> scope, api_version older than 2024-04, or contract state doesn't allow this action.
              </Text>
            </BlockStack>
          </Banner>
        )}
        {s.status === "CANCELLED" && <Banner tone="critical" title="This subscription has been cancelled." />}
        {s.status === "FAILED" && (
          <Banner tone="warning" title="Last payment failed.">
            <Text as="p">Resume once the customer updates their payment method.</Text>
          </Banner>
        )}

        {/* ── Main 2-col layout ───────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: "20px", alignItems: "start" }}>

          {/* Left column */}
          <BlockStack gap="400">
            <SectionCard title="Subscription details">
              <DetailRow label="Status">{statusPill(s.status)}</DetailRow>
              <DetailRow label="Product"><Text as="span" variant="bodySm" fontWeight="semibold">{s.productTitle}</Text></DetailRow>
              <DetailRow label="Plan"><Text as="span" variant="bodySm" tone="subdued">{s.planName}</Text></DetailRow>
              <DetailRow label="Price"><Text as="span" variant="bodySm" fontWeight="semibold">${s.price.toFixed(2)}</Text></DetailRow>
              <DetailRow label="Frequency"><Text as="span" variant="bodySm">{titleCase(s.frequency)}</Text></DetailRow>
              <DetailRow label="Next billing"><Text as="span" variant="bodySm">{fmt(s.nextBillingDate)}</Text></DetailRow>
              <DetailRow label="Created"><Text as="span" variant="bodySm" tone="subdued">{fmt(s.createdAt)}</Text></DetailRow>
              <DetailRowLast label="Last updated"><Text as="span" variant="bodySm" tone="subdued">{fmt(s.updatedAt)}</Text></DetailRowLast>
            </SectionCard>

            <SectionCard title={`Billing history (${s.billingAttempts.length})`}>
              {s.billingAttempts.length === 0 ? (
                <div style={{ padding: "16px 0" }}>
                  <Text as="p" tone="subdued">No billing attempts recorded yet.</Text>
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        {["Date", "Amount", "Status", "Error"].map((h, i) => (
                          <th key={i} style={{ padding: "10px 16px 10px 0", textAlign: "left", fontSize: "11px", fontWeight: 500, color: "var(--p-color-text-subdued)", letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: "0.5px solid var(--p-color-border)", whiteSpace: "nowrap" }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {s.billingAttempts.map((a, i) => {
                        const isLast = i === s.billingAttempts.length - 1;
                        const cell: React.CSSProperties = { padding: "12px 16px 12px 0", fontSize: "12px", borderBottom: isLast ? "none" : "0.5px solid var(--p-color-border-secondary)", verticalAlign: "middle" };
                        return (
                          <tr key={a.id}>
                            <td style={{ ...cell, color: "var(--p-color-text-subdued)" }}>{fmtDateTime(a.createdAt)}</td>
                            <td style={{ ...cell, fontWeight: 500 }}>${a.amount.toFixed(2)}</td>
                            <td style={cell}>{statusPill(a.status)}</td>
                            <td style={{ ...cell, color: "var(--p-color-text-subdued)", fontSize: "11px" }}>{a.errorMessage ?? "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          </BlockStack>

          {/* Right column */}
          <BlockStack gap="400">
            <SectionCard title="Customer">
              <DetailRow label="Email"><Text as="span" variant="bodySm">{s.customerEmail || "—"}</Text></DetailRow>
              <DetailRowLast label="Customer ID">
                <Text as="span" variant="bodySm" tone="subdued">{s.customerId.split("/").pop() ?? s.customerId}</Text>
              </DetailRowLast>
              {s.customerEmail && (
                <div style={{ paddingBottom: "12px" }}>
                  <button
                    onClick={() => window.open(`https://${s.shop}/admin/customers?email=${encodeURIComponent(s.customerEmail)}`, "_blank")}
                    style={{ fontSize: "12px", padding: "6px 14px", border: "0.5px solid var(--p-color-border-secondary)", borderRadius: "8px", background: "var(--p-color-bg-surface)", color: "var(--p-color-text-subdued)", cursor: "pointer", width: "100%" }}
                  >
                    View in Shopify ↗
                  </button>
                </div>
              )}
            </SectionCard>

            <SectionCard title="Contract IDs">
              <div style={{ padding: "10px 0", borderBottom: "0.5px solid var(--p-color-border-secondary)" }}>
                <Text as="p" variant="bodySm" tone="subdued">Local ID</Text>
                <Text as="p" variant="bodySm"><span style={{ fontFamily: "monospace", fontSize: "11px", wordBreak: "break-all" }}>{s.id}</span></Text>
              </div>
              <div style={{ padding: "10px 0 12px" }}>
                <Text as="p" variant="bodySm" tone="subdued">Shopify GID</Text>
                <Text as="p" variant="bodySm"><span style={{ fontFamily: "monospace", fontSize: "11px", wordBreak: "break-all" }}>{toFullGid(s.shopifyContractId)}</span></Text>
              </div>
            </SectionCard>

            <SectionCard title="Billing stats">
              <DetailRow label="Total attempts"><Text as="span" variant="bodySm" fontWeight="semibold">{s.billingAttempts.length}</Text></DetailRow>
              <DetailRow label="Successful">
                <span style={{ fontSize: "12px", fontWeight: 500, color: T.greenFg, background: T.greenBg, padding: "2px 8px", borderRadius: "20px" }}>{successAttempts.length}</span>
              </DetailRow>
              <DetailRow label="Failed">
                <span style={{ fontSize: "12px", fontWeight: 500, color: T.redFg, background: T.redBg, padding: "2px 8px", borderRadius: "20px" }}>{failedAttempts.length}</span>
              </DetailRow>
              <DetailRowLast label="Total collected">
                <Text as="span" variant="bodySm" fontWeight="semibold">${totalCollected.toFixed(2)}</Text>
              </DetailRowLast>
            </SectionCard>
          </BlockStack>

        </div>
      </BlockStack>
    </Page>
  );
}
