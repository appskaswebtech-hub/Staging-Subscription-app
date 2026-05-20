// app/routes/app.customers.tsx

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { useState, useCallback } from "react";
import {
  Page,
  BlockStack,
  InlineStack,
  Text,
  EmptyState,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncSubscriptionsFromShopify } from "../shopify/subscriptionContracts.server";

const PAGE_SIZE = 20;

// ─── Design tokens ───────────────────────────────────────────
const T = {
  purple:     "#7F77DD",
  purpleBg:   "#EEEDFE",
  purpleDark: "#26215C",
  purpleFg:   "#3C3489",
  purpleMid:  "#534AB7",
  greenBg:    "#EAF3DE",
  greenFg:    "#27500A",
  greenDot:   "#3B6D11",
  amberBg:    "#FAEEDA",
  amberFg:    "#633806",
  amberDot:   "#BA7517",
  redBg:      "#FCEBEB",
  redFg:      "#791F1F",
  tealBg:     "#E1F5EE",
  tealFg:     "#085041",
};

// ─── MRR multiplier by frequency ─────────────────────────────
const MRR_MULTIPLIER: Record<string, number> = {
  DAILY:    30,
  WEEKLY:   4.33,
  BIWEEKLY: 2.17,
  MONTHLY:  1,
  YEARLY:   0.083,
};

function calcMrr(price: number, frequency: string): number {
  return price * (MRR_MULTIPLIER[frequency] ?? 1);
}

// ─── Types ────────────────────────────────────────────────────
type CustomerRow = {
  shopifyCustomerId: string;
  email:             string;
  firstName:         string | null;
  lastName:          string | null;
  totalSubs:         number;
  activeSubs:        number;
  mrr:               number;
  totalCollected:    number;
  lastSubDate:       string | null;
};

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const url  = new URL(request.url);
  const q    = url.searchParams.get("q") ?? "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const skip = (page - 1) * PAGE_SIZE;

  try {
    await syncSubscriptionsFromShopify(admin, session.shop);
  } catch (err: any) {
    console.warn(`[customers] sync failed for ${session.shop}:`, err?.message ?? err);
  }

  // ── Search mode — live from Shopify API ──────────────────────
  if (q && q.length >= 2) {
    const response = await admin.graphql(
      `query searchCustomers($query: String!) {
        customers(first: 10, query: $query) {
          edges {
            node { id email firstName lastName }
          }
        }
      }`,
      { variables: { query: q } },
    );
    const data      = await response.json();
    const customers = (data.data?.customers?.edges ?? []).map(({ node }: any) => ({
      shopifyCustomerId: node.id,
      email:          node.email     ?? "",
      firstName:      node.firstName ?? null,
      lastName:       node.lastName  ?? null,
      totalSubs:      0,
      activeSubs:     0,
      mrr:            0,
      totalCollected: 0,
      lastSubDate:    null,
    }));
    return json({
      customers: customers as CustomerRow[],
      total:      customers.length,
      page:       1,
      totalPages: 1,
      stats:      null,
      searchMode: true,
    });
  }

  // ── List mode — from local DB ────────────────────────────────
  const rawCustomers = await prisma.subscription.groupBy({
    by:      ["customerId", "customerEmail"],
    where:   { shop: session.shop },
    _count:  { id: true },
    orderBy: { _count: { id: "desc" } },
    skip,
    take:    PAGE_SIZE,
  });

  const total = await prisma.subscription
    .groupBy({ by: ["customerId"], where: { shop: session.shop } })
    .then((r) => r.length);

  // ── Per-customer stats ───────────────────────────────────────
  const customers: CustomerRow[] = await Promise.all(
    rawCustomers.map(async (c) => {
      const [activeSubs, lastSub, activePlans, collectedAgg] = await Promise.all([
        // active sub count
        prisma.subscription.count({
          where: { shop: session.shop, customerId: c.customerId, status: "ACTIVE" },
        }),
        // last sub date
        prisma.subscription.findFirst({
          where:   { shop: session.shop, customerId: c.customerId },
          orderBy: { createdAt: "desc" },
          select:  { createdAt: true },
        }),
        // active plans for MRR calc (price + frequency)
        prisma.subscription.findMany({
          where:  { shop: session.shop, customerId: c.customerId, status: "ACTIVE" },
          select: { price: true, frequency: true },
        }),
        // total collected from successful billing attempts
        prisma.billingAttempt.aggregate({
          where: {
            subscription: { shop: session.shop, customerId: c.customerId },
            status: "SUCCESS",
          },
          _sum: { amount: true },
        }),
      ]);

      // MRR = sum of each active plan's price × frequency multiplier
      const mrr = activePlans.reduce(
        (sum, s) => sum + calcMrr(s.price, s.frequency),
        0,
      );

      return {
        shopifyCustomerId: c.customerId,
        email:          c.customerEmail,
        firstName:      null,
        lastName:       null,
        totalSubs:      c._count.id,
        activeSubs,
        mrr,
        totalCollected: collectedAgg._sum.amount ?? 0,
        lastSubDate:    lastSub?.createdAt
          ? new Date(lastSub.createdAt).toLocaleDateString("en-GB", {
              day: "2-digit", month: "short", year: "numeric",
            })
          : null,
      };
    }),
  );

  // ── Global stats ─────────────────────────────────────────────
  const uniqueActive = await prisma.subscription
    .groupBy({ by: ["customerId"], where: { shop: session.shop, status: "ACTIVE" } })
    .then((r) => r.length);

  // Combined MRR — sum all active subs with correct frequency multiplier
  const allActiveSubs = await prisma.subscription.findMany({
    where:  { shop: session.shop, status: "ACTIVE" },
    select: { price: true, frequency: true },
  });
  const combinedMrr = allActiveSubs.reduce(
    (sum, s) => sum + calcMrr(s.price, s.frequency),
    0,
  );

  // Total collected — sum all successful billing attempts
  const totalCollectedAgg = await prisma.billingAttempt.aggregate({
    where: { subscription: { shop: session.shop }, status: "SUCCESS" },
    _sum:  { amount: true },
  });

  return json({
    customers,
    total,
    page,
    totalPages: Math.ceil(total / PAGE_SIZE),
    searchMode: false,
    stats: {
      totalCustomers:  total,
      activeCustomers: uniqueActive,
      combinedMrr,
      totalCollected:  totalCollectedAgg._sum.amount ?? 0,
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────
function avatarInitials(row: CustomerRow): string {
  if (row.firstName) return row.firstName[0].toUpperCase();
  if (row.email)     return row.email[0].toUpperCase();
  return "?";
}

function statusPill(activeSubs: number, totalSubs: number) {
  if (activeSubs === totalSubs && totalSubs > 0)
    return { label: "Active",   bg: T.greenBg, color: T.greenFg, dot: T.greenDot };
  if (activeSubs === 0)
    return { label: "Inactive", bg: T.redBg,   color: T.redFg,   dot: "#E24B4A"  };
  return   { label: "Partial",  bg: T.amberBg, color: T.amberFg, dot: T.amberDot };
}

const AVATAR_COLORS = [
  { bg: T.purpleBg, color: T.purpleFg },
  { bg: T.tealBg,   color: T.tealFg   },
  { bg: T.amberBg,  color: T.amberFg  },
  { bg: T.greenBg,  color: T.greenFg  },
];

// ─── Metric card ─────────────────────────────────────────────
function MetricCard({
  label, value, sub, accentColor,
}: {
  label: string; value: string | number; sub: string; accentColor: string;
}) {
  return (
    <div
      style={{
        flex:         1,
        background:   "var(--p-color-bg-surface)",
        border:       "0.5px solid var(--p-color-border)",
        borderRadius: "14px",
        padding:      "18px 20px",
        position:     "relative",
        overflow:     "hidden",
      }}
    >
      <div
        style={{
          position:     "absolute",
          top:          0,
          left:         0,
          right:        0,
          height:       "3px",
          background:   accentColor,
          borderRadius: "14px 14px 0 0",
        }}
      />
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="p" variant="heading2xl" fontWeight="bold">{value}</Text>
        <Text as="p" variant="bodySm" tone="subdued">{sub}</Text>
      </BlockStack>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────
export default function Customers() {
  const { customers, total, page, totalPages, stats, searchMode } =
    useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [searchInput, setSearchInput] = useState(params.get("q") ?? "");

  const goTo = useCallback(
    (updates: Record<string, string>) => {
      const next = new URLSearchParams(window.location.search);
      Object.entries(updates).forEach(([k, v]) =>
        v ? next.set(k, v) : next.delete(k),
      );
      navigate(`?${next.toString()}`);
    },
    [navigate],
  );

  // Table styles
  const th: React.CSSProperties = {
    padding:       "11px 16px",
    textAlign:     "left",
    fontSize:      "11px",
    fontWeight:    500,
    color:         "var(--p-color-text-subdued)",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    borderBottom:  "0.5px solid var(--p-color-border)",
    whiteSpace:    "nowrap",
    background:    "var(--p-color-bg-surface-secondary)",
  };
  const td: React.CSSProperties = {
    padding:       "14px 16px",
    fontSize:      "13px",
    color:         "var(--p-color-text)",
    borderBottom:  "0.5px solid var(--p-color-border-secondary)",
    verticalAlign: "middle",
    overflow:      "hidden",
    textOverflow:  "ellipsis",
    whiteSpace:    "nowrap",
  };

  const activeCount =
    stats?.activeCustomers ??
    customers.filter((c) => c.activeSubs > 0).length;

  return (
    <Page>
      <TitleBar title="Customers" />

      <BlockStack gap="600">

        {/* ── Page header ─────────────────────────────── */}
        <BlockStack gap="100">
          <InlineStack gap="150" blockAlign="center">
            <span
              style={{
                width:        "6px",
                height:       "6px",
                borderRadius: "50%",
                background:   T.purple,
                display:      "inline-block",
                flexShrink:   0,
              }}
            />
            <Text as="span" variant="bodySm" tone="subdued">
              KAS Subscription › Customers
            </Text>
          </InlineStack>
          <Text as="h1" variant="headingXl" fontWeight="bold">
            Customers
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {activeCount} active of {total} total
          </Text>
        </BlockStack>

        {/* ── Metric cards ────────────────────────────── */}
        {!searchMode && stats && (
          <div style={{ display: "flex", gap: "14px" }}>
            <MetricCard
              label="Total customers"
              value={stats.totalCustomers}
              sub="All time"
              accentColor={T.purple}
            />
            <MetricCard
              label="Active customers"
              value={stats.activeCustomers}
              sub="With live subscriptions"
              accentColor={T.greenDot}
            />
            <MetricCard
              label="Combined MRR"
              value={`$${stats.combinedMrr.toFixed(2)}`}
              sub="Monthly recurring (normalized)"
              accentColor="#1D9E75"
            />
            <MetricCard
              label="Total collected"
              value={`$${stats.totalCollected.toFixed(2)}`}
              sub="Lifetime revenue"
              accentColor={T.amberDot}
            />
          </div>
        )}

        {/* ── Main card ───────────────────────────────── */}
        <div
          style={{
            background:   "var(--p-color-bg-surface)",
            border:       "0.5px solid var(--p-color-border)",
            borderRadius: "14px",
            overflow:     "hidden",
          }}
        >
          {/* Toolbar */}
          <div
            style={{
              display:      "flex",
              alignItems:   "center",
              gap:          "10px",
              padding:      "12px 20px",
              borderBottom: "0.5px solid var(--p-color-border)",
              background:   "var(--p-color-bg-surface-secondary)",
            }}
          >
            <div
              style={{
                flex:         1,
                display:      "flex",
                alignItems:   "center",
                gap:          "8px",
                background:   "var(--p-color-bg-surface)",
                border:       "0.5px solid var(--p-color-border-secondary)",
                borderRadius: "9px",
                padding:      "8px 12px",
              }}
            >
              <svg
                width="14" height="14" fill="none"
                stroke="var(--p-color-text-subdued)"
                strokeWidth="2" viewBox="0 0 24 24"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" && goTo({ q: searchInput, page: "1" })
                }
                onBlur={() =>
                  searchInput.length >= 2 && goTo({ q: searchInput, page: "1" })
                }
                placeholder="Search by email or customer ID…"
                style={{
                  border:     "none",
                  background: "transparent",
                  fontSize:   "13px",
                  color:      "var(--p-color-text)",
                  outline:    "none",
                  width:      "100%",
                }}
              />
              {searchInput && (
                <button
                  onClick={() => { setSearchInput(""); goTo({ q: "", page: "1" }); }}
                  style={{
                    background: "none",
                    border:     "none",
                    cursor:     "pointer",
                    color:      "var(--p-color-text-subdued)",
                    fontSize:   "16px",
                    lineHeight: "1",
                    padding:    "0",
                  }}
                >
                  ×
                </button>
              )}
            </div>

            {searchMode && (
              <button
                onClick={() => { setSearchInput(""); navigate("?"); }}
                style={{
                  fontSize:     "12px",
                  padding:      "7px 14px",
                  border:       `0.5px solid #AFA9EC`,
                  borderRadius: "20px",
                  background:   T.purpleBg,
                  color:        T.purpleFg,
                  cursor:       "pointer",
                  whiteSpace:   "nowrap",
                  fontWeight:   500,
                }}
              >
                ← All customers
              </button>
            )}
          </div>

          {/* Table or empty */}
          {customers.length === 0 ? (
            <div style={{ padding: "48px 24px" }}>
              <EmptyState
                heading="No customers found"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <Text as="p" tone="subdued">
                  {searchMode
                    ? "No customers matched your search query."
                    : "Customers will appear once subscriptions are created."}
                </Text>
              </EmptyState>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width:           "100%",
                  borderCollapse:  "collapse",
                  tableLayout:     "fixed",
                }}
              >
                <colgroup>
                  <col style={{ width: "30%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "6%"  }} />
                </colgroup>
                <thead>
                  <tr>
                    {[
                      "Customer",
                      "Status",
                      "Subscriptions",
                      "MRR",
                      "Total collected",
                      "Last subscription",
                      "",
                    ].map((h, i) => (
                      <th key={i} style={th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {customers.map((c, i) => {
                    const isLast = i === customers.length - 1;
                    const cell   = isLast ? { ...td, borderBottom: "none" } : td;
                    const avatar = AVATAR_COLORS[i % AVATAR_COLORS.length];
                    const pill   = statusPill(c.activeSubs, c.totalSubs);
                    const initials = avatarInitials(c);

                    return (
                      <tr
                        key={c.shopifyCustomerId}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.background =
                            "var(--p-color-bg-surface-hover)")
                        }
                        onMouseLeave={(e) =>
                          (e.currentTarget.style.background = "transparent")
                        }
                        style={{ transition: "background 0.1s", cursor: "pointer" }}
                        onClick={() =>
                          navigate(
                            `/app/customers-edit/${c.shopifyCustomerId.split("/").pop()}`,
                          )
                        }
                      >
                        {/* Customer */}
                        <td style={cell}>
                          <div
                            style={{
                              display:    "flex",
                              alignItems: "center",
                              gap:        "10px",
                              overflow:   "hidden",
                            }}
                          >
                            <div
                              style={{
                                width:          "32px",
                                height:         "32px",
                                borderRadius:   "50%",
                                background:     avatar.bg,
                                color:          avatar.color,
                                display:        "flex",
                                alignItems:     "center",
                                justifyContent: "center",
                                fontSize:       "13px",
                                fontWeight:     500,
                                flexShrink:     0,
                              }}
                            >
                              {initials}
                            </div>
                            <div style={{ overflow: "hidden" }}>
                              <div
                                style={{
                                  fontSize:     "13px",
                                  fontWeight:   500,
                                  overflow:     "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {c.email || "—"}
                              </div>
                              <div
                                style={{
                                  fontSize:  "11px",
                                  color:     "var(--p-color-text-subdued)",
                                  marginTop: "1px",
                                }}
                              >
                                ID: {c.shopifyCustomerId}
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* Status */}
                        <td style={cell}>
                          <span
                            style={{
                              display:      "inline-flex",
                              alignItems:   "center",
                              gap:          "5px",
                              fontSize:     "11px",
                              fontWeight:   500,
                              padding:      "4px 10px",
                              background:   pill.bg,
                              color:        pill.color,
                              borderRadius: "20px",
                            }}
                          >
                            <span
                              style={{
                                width:        "5px",
                                height:       "5px",
                                borderRadius: "50%",
                                background:   pill.dot,
                                display:      "inline-block",
                              }}
                            />
                            {pill.label}
                          </span>
                        </td>

                        {/* Subscriptions */}
                        <td
                          style={{
                            ...cell,
                            color:    "var(--p-color-text-subdued)",
                            fontSize: "12px",
                          }}
                        >
                          {searchMode
                            ? "—"
                            : `${c.activeSubs} active / ${c.totalSubs} total`}
                        </td>

                        {/* MRR */}
                        <td style={{ ...cell, fontWeight: 500 }}>
                          {searchMode ? "—" : `$${c.mrr.toFixed(2)}/mo`}
                        </td>

                        {/* Total collected */}
                        <td style={{ ...cell, color: "var(--p-color-text-subdued)" }}>
                          {searchMode ? "—" : `$${c.totalCollected.toFixed(2)}`}
                        </td>

                        {/* Last subscription */}
                        <td style={{ ...cell, color: "var(--p-color-text-subdued)" }}>
                          {searchMode ? "—" : (c.lastSubDate ?? "—")}
                        </td>

                        {/* View */}
                        <td
                          style={{ ...cell, overflow: "visible" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() =>
                              navigate(
                                `/app/customers-edit/${c.shopifyCustomerId.split("/").pop()}`,
                              )
                            }
                            style={{
                              fontSize:     "12px",
                              padding:      "5px 12px",
                              border:       "0.5px solid var(--p-color-border-secondary)",
                              borderRadius: "7px",
                              background:   "var(--p-color-bg-surface)",
                              color:        "var(--p-color-text)",
                              cursor:       "pointer",
                              whiteSpace:   "nowrap",
                            }}
                          >
                            View →
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Pagination ───────────────────────────────── */}
          {!searchMode && totalPages > 1 && (
            <div
              style={{
                display:        "flex",
                alignItems:     "center",
                justifyContent: "space-between",
                padding:        "13px 20px",
                borderTop:      "0.5px solid var(--p-color-border)",
              }}
            >
              <Text as="p" variant="bodySm" tone="subdued">
                {total} customer{total !== 1 ? "s" : ""}
              </Text>
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  disabled={page <= 1}
                  onClick={() => goTo({ page: String(page - 1) })}
                  style={{
                    padding:      "6px 14px",
                    border:       "0.5px solid var(--p-color-border-secondary)",
                    borderRadius: "8px",
                    background:   "var(--p-color-bg-surface)",
                    color:
                      page <= 1
                        ? "var(--p-color-text-disabled)"
                        : "var(--p-color-text)",
                    fontSize: "12px",
                    cursor:   page <= 1 ? "not-allowed" : "pointer",
                  }}
                >
                  ← Prev
                </button>
                <button
                  disabled={page >= totalPages}
                  onClick={() => goTo({ page: String(page + 1) })}
                  style={{
                    padding:      "6px 14px",
                    border:       "0.5px solid var(--p-color-border-secondary)",
                    borderRadius: "8px",
                    background:   "var(--p-color-bg-surface)",
                    color:
                      page >= totalPages
                        ? "var(--p-color-text-disabled)"
                        : "var(--p-color-text)",
                    fontSize: "12px",
                    cursor:   page >= totalPages ? "not-allowed" : "pointer",
                  }}
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>

      </BlockStack>
    </Page>
  );
}
