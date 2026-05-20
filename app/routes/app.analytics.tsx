// app/routes/app.analytics.tsx
// ─────────────────────────────────────────────────────────────
// Analytics dashboard for subscription metrics
//
// Sections:
//   1. KPI cards  — MRR, Active subs, Churn rate, Avg revenue per sub,
//                   Billing success rate, Total revenue collected
//   2. Subscription growth — new subs per month (last 12 months)
//   3. Revenue by frequency — MRR split by WEEKLY/MONTHLY/YEARLY
//   4. Status breakdown — pie-style bar chart
//   5. Billing outcomes — success vs failure per month (last 6 months)
//   6. Top products — by active subscription count + MRR contribution
// ─────────────────────────────────────────────────────────────

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Divider,
  Badge,
  DataTable,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const now       = new Date();
  const monthsAgo = (n: number) => {
    const d = new Date(now);
    d.setMonth(d.getMonth() - n);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  // ── Fetch everything we need in parallel ──────────────────
  const [
    allSubs,
    billingAttempts,
    newSubsRaw,
  ] = await Promise.all([
    // All subscriptions for this shop
    prisma.subscription.findMany({
      where:   { shop },
      select:  {
        id:              true,
        status:          true,
        price:           true,
        frequency:       true,
        productTitle:    true,
        planName:        true,
        createdAt:       true,
      },
    }),

    // All billing attempts linked to this shop's subscriptions
    prisma.billingAttempt.findMany({
      where:   { subscription: { shop } },
      select:  { amount: true, status: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),

    // New subscriptions per month — last 12 months
    prisma.subscription.findMany({
      where:   { shop, createdAt: { gte: monthsAgo(12) } },
      select:  { createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // ── KPIs ──────────────────────────────────────────────────
  const activeSubs   = allSubs.filter((s) => s.status === "ACTIVE");
  const cancelledSubs = allSubs.filter((s) => s.status === "CANCELLED");

  // MRR: normalise all active subs to a monthly value
  function toMonthlyValue(price: number, frequency: string): number {
    switch (frequency) {
      case "DAILY":    return price * 30;
      case "WEEKLY":   return price * 4.33;
      case "BIWEEKLY": return price * 2.17;
      case "MONTHLY":  return price;
      case "YEARLY":   return price / 12;
      default:         return price;
    }
  }

  const mrr = activeSubs.reduce(
    (sum, s) => sum + toMonthlyValue(s.price, s.frequency),
    0,
  );

  const totalRevenue = billingAttempts
    .filter((a) => a.status === "SUCCESS")
    .reduce((sum, a) => sum + a.amount, 0);

  const avgRevenuePerSub = activeSubs.length > 0 ? mrr / activeSubs.length : 0;

  // Churn rate = cancelled / (active + cancelled)  × 100
  const churnBase  = activeSubs.length + cancelledSubs.length;
  const churnRate  = churnBase > 0 ? (cancelledSubs.length / churnBase) * 100 : 0;

  const totalBilling   = billingAttempts.length;
  const successBilling = billingAttempts.filter((a) => a.status === "SUCCESS").length;
  const billingSuccessRate = totalBilling > 0 ? (successBilling / totalBilling) * 100 : 0;

  // ── Status breakdown ──────────────────────────────────────
  const statusCounts: Record<string, number> = {};
  allSubs.forEach((s) => {
    statusCounts[s.status] = (statusCounts[s.status] ?? 0) + 1;
  });

  // ── Revenue by frequency ──────────────────────────────────
  const revenueByFreq: Record<string, { count: number; mrr: number }> = {};
  activeSubs.forEach((s) => {
    if (!revenueByFreq[s.frequency]) revenueByFreq[s.frequency] = { count: 0, mrr: 0 };
    revenueByFreq[s.frequency].count += 1;
    revenueByFreq[s.frequency].mrr   += toMonthlyValue(s.price, s.frequency);
  });

  // ── New subscriptions per month (last 12) ─────────────────
  const growthMap: Record<string, number> = {};
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now);
    d.setMonth(d.getMonth() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    growthMap[key] = 0;
  }
  newSubsRaw.forEach((s) => {
    const d = new Date(s.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (key in growthMap) growthMap[key] = (growthMap[key] ?? 0) + 1;
  });
  const growthData = Object.entries(growthMap).map(([month, count]) => ({
    month,
    label: new Date(month + "-01").toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
    count,
  }));

  // ── Billing outcomes per month (last 6) ───────────────────
  const billingMap: Record<string, { success: number; failed: number }> = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now);
    d.setMonth(d.getMonth() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    billingMap[key] = { success: 0, failed: 0 };
  }
  billingAttempts.forEach((a) => {
    const d = new Date(a.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!(key in billingMap)) return;
    if (a.status === "SUCCESS") billingMap[key].success += 1;
    else if (a.status === "FAILED") billingMap[key].failed  += 1;
  });
  const billingData = Object.entries(billingMap).map(([month, v]) => ({
    month,
    label: new Date(month + "-01").toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
    ...v,
  }));

  // ── Top products ──────────────────────────────────────────
  const productMap: Record<string, { count: number; mrr: number }> = {};
  activeSubs.forEach((s) => {
    const key = s.productTitle;
    if (!productMap[key]) productMap[key] = { count: 0, mrr: 0 };
    productMap[key].count += 1;
    productMap[key].mrr   += toMonthlyValue(s.price, s.frequency);
  });
  const topProducts = Object.entries(productMap)
    .map(([title, v]) => ({ title, ...v }))
    .sort((a, b) => b.mrr - a.mrr)
    .slice(0, 10);

  return json({
    kpis: {
      mrr,
      totalRevenue,
      activeSubs:        activeSubs.length,
      totalSubs:         allSubs.length,
      avgRevenuePerSub,
      churnRate,
      billingSuccessRate,
      totalBillingAttempts: totalBilling,
    },
    statusCounts,
    revenueByFreq,
    growthData,
    billingData,
    topProducts,
  });
}

// ─── Helpers ─────────────────────────────────────────────────
function fmt$(n: number) {
  return new Intl.NumberFormat("en-US", {
    style:             "currency",
    currency:          "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtPct(n: number) {
  return `${n.toFixed(1)}%`;
}

type KpiCardProps = {
  title:    string;
  value:    string;
  subtitle?: string;
  tone?:    "success" | "warning" | "critical" | "default";
};

function KpiCard({ title, value, subtitle, tone = "default" }: KpiCardProps) {
  const valueColor: Record<string, string> = {
    success:  "var(--p-color-text-success)",
    warning:  "var(--p-color-text-caution)",
    critical: "var(--p-color-text-critical)",
    default:  "var(--p-color-text)",
  };

  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodyMd" tone="subdued">{title}</Text>
        <Text
          as="p"
          variant="heading2xl"
          fontWeight="bold"
        >
          <span style={{ color: valueColor[tone] }}>{value}</span>
        </Text>
        {subtitle && (
          <Text as="p" variant="bodySm" tone="subdued">{subtitle}</Text>
        )}
      </BlockStack>
    </Card>
  );
}

// Simple horizontal bar chart built from Polaris primitives — no charting lib needed
type BarChartProps = {
  data:       { label: string; value: number; color?: string }[];
  maxValue?:  number;
  formatValue?: (v: number) => string;
  height?:    number;
};

function HorizontalBarChart({ data, maxValue, formatValue, height = 28 }: BarChartProps) {
  const max = maxValue ?? Math.max(...data.map((d) => d.value), 1);
  return (
    <BlockStack gap="200">
      {data.map((d) => (
        <div key={d.label}>
          <InlineStack align="space-between" blockAlign="center">
            <Text as="span" variant="bodySm">{d.label}</Text>
            <Text as="span" variant="bodySm" fontWeight="semibold">
              {formatValue ? formatValue(d.value) : d.value}
            </Text>
          </InlineStack>
          <div
            style={{
              marginTop:    "4px",
              height:       `${height}px`,
              background:   "var(--p-color-bg-surface-secondary)",
              borderRadius: "4px",
              overflow:     "hidden",
            }}
          >
            <div
              style={{
                height:     "100%",
                width:      `${Math.max((d.value / max) * 100, d.value > 0 ? 2 : 0)}%`,
                background: d.color ?? "var(--p-color-bg-fill-success)",
                borderRadius: "4px",
                transition: "width 0.4s ease",
              }}
            />
          </div>
        </div>
      ))}
    </BlockStack>
  );
}

// Vertical bar chart for time-series
type VerticalBarProps = {
  data:        { label: string; value: number; color?: string }[];
  maxValue?:   number;
  formatValue?: (v: number) => string;
};

function VerticalBarChart({ data, maxValue, formatValue }: VerticalBarProps) {
  const max = maxValue ?? Math.max(...data.map((d) => d.value), 1);
  return (
    <div
      style={{
        display:       "flex",
        alignItems:    "flex-end",
        gap:           "8px",
        height:        "160px",
        paddingBottom: "28px",
        position:      "relative",
      }}
    >
      {data.map((d) => {
        const pct = max > 0 ? (d.value / max) * 100 : 0;
        return (
          <div
            key={d.label}
            style={{
              flex:          1,
              display:       "flex",
              flexDirection: "column",
              alignItems:    "center",
              height:        "100%",
              justifyContent: "flex-end",
              position:      "relative",
            }}
          >
            {/* Value label */}
            <span
              style={{
                fontSize:     "10px",
                color:        "var(--p-color-text-subdued)",
                marginBottom: "2px",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {formatValue ? formatValue(d.value) : d.value}
            </span>
            {/* Bar */}
            <div
              style={{
                width:        "100%",
                height:       `${Math.max(pct, d.value > 0 ? 4 : 0)}%`,
                background:   d.color ?? "var(--p-color-bg-fill-success)",
                borderRadius: "4px 4px 0 0",
                transition:   "height 0.4s ease",
                minHeight:    d.value > 0 ? "4px" : "0",
              }}
            />
            {/* X label */}
            <span
              style={{
                position:   "absolute",
                bottom:     "-24px",
                fontSize:   "10px",
                color:      "var(--p-color-text-subdued)",
                textAlign:  "center",
                width:      "100%",
                whiteSpace: "nowrap",
                overflow:   "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {d.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Stacked vertical bar for billing success/failure
type StackedBarProps = {
  data: { label: string; success: number; failed: number }[];
};

function StackedBillingChart({ data }: StackedBarProps) {
  const max = Math.max(...data.map((d) => d.success + d.failed), 1);
  return (
    <div
      style={{
        display:        "flex",
        alignItems:     "flex-end",
        gap:            "8px",
        height:         "160px",
        paddingBottom:  "28px",
      }}
    >
      {data.map((d) => {
        const total      = d.success + d.failed;
        const totalPct   = max > 0 ? (total / max) * 100 : 0;
        const successPct = total > 0 ? (d.success / total) * 100 : 0;
        const failedPct  = 100 - successPct;

        return (
          <div
            key={d.label}
            style={{
              flex:           1,
              display:        "flex",
              flexDirection:  "column",
              alignItems:     "center",
              height:         "100%",
              justifyContent: "flex-end",
              position:       "relative",
            }}
          >
            <span style={{ fontSize: "10px", color: "var(--p-color-text-subdued)", marginBottom: "2px" }}>
              {total}
            </span>
            <div
              style={{
                width:        "100%",
                height:       `${Math.max(totalPct, total > 0 ? 4 : 0)}%`,
                borderRadius: "4px 4px 0 0",
                overflow:     "hidden",
                display:      "flex",
                flexDirection: "column",
                minHeight:    total > 0 ? "4px" : "0",
              }}
            >
              <div style={{ flex: failedPct,  background: "var(--p-color-bg-fill-critical)" }} />
              <div style={{ flex: successPct, background: "var(--p-color-bg-fill-success)"  }} />
            </div>
            <span
              style={{
                position:    "absolute",
                bottom:      "-24px",
                fontSize:    "10px",
                color:       "var(--p-color-text-subdued)",
                textAlign:   "center",
                width:       "100%",
                whiteSpace:  "nowrap",
                overflow:    "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {d.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Status badge tone ────────────────────────────────────────
type BadgeTone = "success" | "warning" | "critical" | "info";
function badgeTone(s: string): BadgeTone {
  return ({ ACTIVE: "success", PAUSED: "warning", CANCELLED: "critical", FAILED: "critical", PENDING: "info" } as Record<string, BadgeTone>)[s] ?? "info";
}

function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ─── Page ─────────────────────────────────────────────────────
export default function Analytics() {
  const {
    kpis,
    statusCounts,
    revenueByFreq,
    growthData,
    billingData,
    topProducts,
  } = useLoaderData<typeof loader>();

  // ── Status breakdown bars ──────────────────────────────────
  const statusColors: Record<string, string> = {
    ACTIVE:    "var(--p-color-bg-fill-success)",
    PAUSED:    "var(--p-color-bg-fill-caution)",
    CANCELLED: "var(--p-color-bg-fill-critical)",
    FAILED:    "var(--p-color-bg-fill-critical)",
    PENDING:   "var(--p-color-bg-fill-info)",
  };
  const statusBars = Object.entries(statusCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => ({
      label: titleCase(status),
      value: count,
      color: statusColors[status],
    }));

  // ── Revenue by frequency bars ──────────────────────────────
  const freqBars = Object.entries(revenueByFreq)
    .sort((a, b) => b[1].mrr - a[1].mrr)
    .map(([freq, v]) => ({
      label: `${titleCase(freq)} (${v.count})`,
      value: v.mrr,
      color: "var(--p-color-bg-fill-brand)",
    }));

  // ── DataTable rows for top products ───────────────────────
  const productRows = topProducts.map((p, i) => [
    `${i + 1}`,
    p.title,
    String(p.count),
    fmt$(p.mrr),
  ]);

  return (
    <Page
      title="Analytics"
      subtitle="Subscription performance overview"
      backAction={{ content: "Dashboard", url: "/app" }}
    >
      <TitleBar title="Analytics" />

      <BlockStack gap="600">

        {/* ── 1. KPI cards ──────────────────────────────────── */}
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">Key Metrics</Text>

          {/* Row 1 */}
          <div
            style={{
              display:             "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap:                 "16px",
            }}
          >
            <KpiCard
              title="Monthly Recurring Revenue"
              value={fmt$(kpis.mrr)}
              subtitle="Normalised from all active subscriptions"
              tone="success"
            />
            <KpiCard
              title="Active Subscriptions"
              value={String(kpis.activeSubs)}
              subtitle={`${kpis.totalSubs} total across all statuses`}
            />
            <KpiCard
              title="Total Revenue Collected"
              value={fmt$(kpis.totalRevenue)}
              subtitle={`From ${kpis.totalBillingAttempts} billing attempts`}
              tone="success"
            />
            <KpiCard
              title="Avg Revenue / Subscription"
              value={fmt$(kpis.avgRevenuePerSub)}
              subtitle="MRR ÷ active subscriptions"
            />
            <KpiCard
              title="Billing Success Rate"
              value={fmtPct(kpis.billingSuccessRate)}
              subtitle={`${kpis.totalBillingAttempts} total attempts`}
              tone={kpis.billingSuccessRate >= 90 ? "success" : kpis.billingSuccessRate >= 70 ? "warning" : "critical"}
            />
            <KpiCard
              title="Churn Rate"
              value={fmtPct(kpis.churnRate)}
              subtitle="Cancelled ÷ (active + cancelled)"
              tone={kpis.churnRate <= 5 ? "success" : kpis.churnRate <= 15 ? "warning" : "critical"}
            />
          </div>
        </BlockStack>

        <Divider />

        {/* ── 2. Growth + Billing outcomes ──────────────────── */}
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">New Subscriptions — Last 12 Months</Text>
                <VerticalBarChart
                  data={growthData.map((d) => ({
                    label: d.label,
                    value: d.count,
                    color: "var(--p-color-bg-fill-brand)",
                  }))}
                  formatValue={(v) => String(v)}
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Billing Outcomes — Last 6 Months</Text>
                  <InlineStack gap="300">
                    <InlineStack gap="100" blockAlign="center">
                      <div style={{ width: 10, height: 10, borderRadius: 2, background: "var(--p-color-bg-fill-success)" }} />
                      <Text as="span" variant="bodySm" tone="subdued">Success</Text>
                    </InlineStack>
                    <InlineStack gap="100" blockAlign="center">
                      <div style={{ width: 10, height: 10, borderRadius: 2, background: "var(--p-color-bg-fill-critical)" }} />
                      <Text as="span" variant="bodySm" tone="subdued">Failed</Text>
                    </InlineStack>
                  </InlineStack>
                </BlockStack>
                <StackedBillingChart data={billingData} />
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* ── 3. Status breakdown + Revenue by frequency ────── */}
        <Layout>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Subscription Status Breakdown</Text>
                  <Text as="p" tone="subdued" variant="bodySm">{kpis.totalSubs} total</Text>
                </InlineStack>

                {statusBars.length === 0 ? (
                  <Text as="p" tone="subdued">No data yet.</Text>
                ) : (
                  <>
                    <HorizontalBarChart
                      data={statusBars}
                      maxValue={kpis.totalSubs}
                      formatValue={(v) => `${v} (${fmtPct(kpis.totalSubs > 0 ? (v / kpis.totalSubs) * 100 : 0)})`}
                    />
                    <Divider />
                    <InlineStack gap="300" wrap>
                      {Object.entries(statusCounts).map(([status, count]) => (
                        <InlineStack key={status} gap="100" blockAlign="center">
                          <Badge tone={badgeTone(status)}>{titleCase(status)}</Badge>
                          <Text as="span" variant="bodySm" fontWeight="semibold">{count}</Text>
                        </InlineStack>
                      ))}
                    </InlineStack>
                  </>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">MRR by Billing Frequency</Text>
                  <Text as="p" tone="subdued" variant="bodySm">{fmt$(kpis.mrr)} total MRR</Text>
                </InlineStack>

                {freqBars.length === 0 ? (
                  <Text as="p" tone="subdued">No active subscriptions yet.</Text>
                ) : (
                  <HorizontalBarChart
                    data={freqBars}
                    maxValue={kpis.mrr}
                    formatValue={(v) => fmt$(v)}
                    height={32}
                  />
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* ── 4. Top products ───────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Top Products by MRR</Text>
            {productRows.length === 0 ? (
              <Text as="p" tone="subdued">No active subscriptions yet.</Text>
            ) : (
              <DataTable
                columnContentTypes={["numeric", "text", "numeric", "numeric"]}
                headings={["#", "Product", "Active Subscribers", "MRR Contribution"]}
                rows={productRows}
                totals={["", "", String(kpis.activeSubs), fmt$(kpis.mrr)]}
                showTotalsInFooter
              />
            )}
          </BlockStack>
        </Card>

      </BlockStack>
    </Page>
  );
}
