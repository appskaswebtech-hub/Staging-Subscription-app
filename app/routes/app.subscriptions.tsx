// app/routes/app.subscriptions.tsx

import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useLoaderData,
  useNavigate,
  useSubmit,
  useSearchParams,
} from "@remix-run/react";
import { useState, useCallback } from "react";
import {
  Page,
  BlockStack,
  InlineStack,
  Text,
  EmptyState,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncSubscriptionsFromShopify } from "../shopify/subscriptionContracts.server";

const PAGE_SIZE = 20;

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
  blueBg:     "#E6F1FB",
  blueFg:     "#185FA5",
};

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const url          = new URL(request.url);
  const statusFilter = url.searchParams.get("status") ?? "";
  const search       = url.searchParams.get("search") ?? "";
  const page         = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const skip         = (page - 1) * PAGE_SIZE;

  try {
    await syncSubscriptionsFromShopify(admin, session.shop);
  } catch (err: any) {
    console.warn(`[subscriptions] sync failed for ${session.shop}:`, err?.message ?? err);
  }

  const where = {
    shop: session.shop,
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(search
      ? { OR: [
            { customerEmail: { contains: search } },
            { productTitle:  { contains: search } },
          ],
        }
      : {}),
  };

  const [subscriptions, total] = await Promise.all([
    prisma.subscription.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: PAGE_SIZE }),
    prisma.subscription.count({ where }),
  ]);

  return json({ subscriptions, total, page, totalPages: Math.ceil(total / PAGE_SIZE) });
}

// ─── Action ───────────────────────────────────────────────────
export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const formData           = await request.formData();
  const localId            = formData.get("id")     as string;
  const newStatus          = formData.get("status") as string;

  const sub = await prisma.subscription.findFirst({ where: { id: localId, shop: session.shop } });
  if (!sub) return json({ error: "Subscription not found" }, { status: 404 });

  const mutation   = newStatus === "PAUSED" ? PAUSE_MUTATION : ACTIVATE_MUTATION;
  const payloadKey = newStatus === "PAUSED" ? "subscriptionContractPause" : "subscriptionContractActivate";

  const res    = await admin.graphql(mutation, { variables: { subscriptionContractId: sub.shopifyContractId } });
  const result = await res.json();
  const errors = (result?.data?.[payloadKey]?.userErrors ?? []) as Array<{ field: string[]; message: string }>;

  if (errors.length > 0)
    return json({ error: errors.map((e) => `${e.field?.join(".") ?? "error"}: ${e.message}`).join(" | ") });

  await prisma.subscription.update({ where: { id: localId }, data: { status: newStatus } });
  return json({ ok: true });
}

// ─── Helpers ─────────────────────────────────────────────────
function statusPill(status: string) {
  const styles: Record<string, { bg: string; color: string; dot: string }> = {
    ACTIVE:    { bg: T.greenBg,  color: T.greenFg,  dot: T.greenDot },
    PAUSED:    { bg: T.amberBg,  color: T.amberFg,  dot: "#BA7517"  },
    CANCELLED: { bg: T.redBg,    color: T.redFg,    dot: "#E24B4A"  },
    FAILED:    { bg: T.redBg,    color: T.redFg,    dot: "#E24B4A"  },
    PENDING:   { bg: T.blueBg,   color: T.blueFg,   dot: "#378ADD"  },
  };
  const s = styles[status] ?? styles.PENDING;
  return (
    <span
      style={{
        display:      "inline-flex",
        alignItems:   "center",
        gap:          "5px",
        fontSize:     "11px",
        fontWeight:   500,
        padding:      "4px 10px",
        background:   s.bg,
        color:        s.color,
        borderRadius: "20px",
        whiteSpace:   "nowrap",
      }}
    >
      <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: s.dot, display: "inline-block" }} />
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ─── Status tab config ────────────────────────────────────────
const STATUS_TABS = [
  { label: "All",       value: ""          },
  { label: "Active",    value: "ACTIVE"    },
  { label: "Paused",    value: "PAUSED"    },
  { label: "Cancelled", value: "CANCELLED" },
];

// ─── Component ────────────────────────────────────────────────
export default function Subscriptions() {
  const { subscriptions, total, page, totalPages } = useLoaderData<typeof loader>();
  const navigate   = useNavigate();
  const submit     = useSubmit();
  const [params]   = useSearchParams();

  const [searchInput,  setSearchInput]  = useState(params.get("search") ?? "");
  const [actionError,  setActionError]  = useState<string | null>(null);
  const activeStatus = params.get("status") ?? "";

  const goTo = useCallback(
    (updates: Record<string, string>) => {
      const next = new URLSearchParams(window.location.search);
      Object.entries(updates).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
      navigate(`?${next.toString()}`);
    },
    [navigate],
  );

  function quickStatus(id: string, status: string) {
    setActionError(null);
    const fd = new FormData();
    fd.append("id", id);
    fd.append("status", status);
    submit(fd, { method: "post" });
  }

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
    padding:      "13px 16px",
    fontSize:     "13px",
    color:        "var(--p-color-text)",
    borderBottom: "0.5px solid var(--p-color-border-secondary)",
    verticalAlign:"middle",
    overflow:     "hidden",
    textOverflow: "ellipsis",
    whiteSpace:   "nowrap",
  };
  const tdLast: React.CSSProperties = { ...td, borderBottom: "none" };

  return (
    <Page>
      <TitleBar title="All Subscriptions" />

      <BlockStack gap="600">

        {/* ── Page header ─────────────────────────────── */}
        <BlockStack gap="100">
          <InlineStack gap="150" blockAlign="center">
            <span
              style={{
                width: "6px", height: "6px", borderRadius: "50%",
                background: T.purple, display: "inline-block", flexShrink: 0,
              }}
            />
            <Text as="span" variant="bodySm" tone="subdued">
              KAS Subscription › Subscriptions
            </Text>
          </InlineStack>
          <Text as="h1" variant="headingXl" fontWeight="bold">
            All subscriptions
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {total} total contract{total !== 1 ? "s" : ""}
          </Text>
        </BlockStack>

        {/* Error banner */}
        {actionError && (
          <Banner tone="critical" title="Action failed" onDismiss={() => setActionError(null)}>
            <Text as="p">{actionError}</Text>
          </Banner>
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
          {/* Status tabs */}
          <div
            style={{
              display:      "flex",
              borderBottom: "0.5px solid var(--p-color-border)",
              padding:      "0 20px",
              overflowX:    "auto",
            }}
          >
            {STATUS_TABS.map((tab) => {
              const isActive = activeStatus === tab.value;
              return (
                <button
                  key={tab.value}
                  onClick={() => goTo({ status: tab.value, page: "1" })}
                  style={{
                    fontSize:      "13px",
                    padding:       "13px 14px 11px",
                    cursor:        "pointer",
                    color:         isActive ? T.purpleDark : "var(--p-color-text-subdued)",
                    fontWeight:    isActive ? 500 : 400,
                    border:        "none",
                    borderBottom:  isActive ? `2px solid ${T.purple}` : "2px solid transparent",
                    background:    "transparent",
                    whiteSpace:    "nowrap",
                    display:       "flex",
                    alignItems:    "center",
                    gap:           "6px",
                  }}
                >
                  {tab.label}
                  {tab.value === "" && (
                    <span
                      style={{
                        fontSize:     "11px",
                        padding:      "1px 7px",
                        borderRadius: "20px",
                        background:   isActive ? T.purpleBg : "var(--p-color-bg-surface-secondary)",
                        color:        isActive ? T.purpleFg : "var(--p-color-text-subdued)",
                      }}
                    >
                      {total}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Search + filter toolbar */}
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
            {/* Search box */}
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
              <svg width="14" height="14" fill="none" stroke="var(--p-color-text-subdued)" strokeWidth="2" viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
              </svg>
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && goTo({ search: searchInput, page: "1" })}
                onBlur={() => goTo({ search: searchInput, page: "1" })}
                placeholder="Search email or product…"
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
                  onClick={() => { setSearchInput(""); goTo({ search: "", page: "1" }); }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--p-color-text-subdued)", fontSize: "16px", lineHeight: 1, padding: 0 }}
                >
                  ×
                </button>
              )}
            </div>

            {/* Status filter chip */}
            <div
              style={{
                fontSize:     "12px",
                color:        activeStatus ? T.purpleFg : "var(--p-color-text-subdued)",
                background:   activeStatus ? T.purpleBg : "var(--p-color-bg-surface)",
                padding:      "7px 13px",
                border:       `0.5px solid ${activeStatus ? "#AFA9EC" : "var(--p-color-border-secondary)"}`,
                borderRadius: "20px",
                cursor:       "pointer",
                whiteSpace:   "nowrap",
                fontWeight:   activeStatus ? 500 : 400,
              }}
              onClick={() => goTo({ status: "", page: "1" })}
            >
              {activeStatus ? `Status: ${titleCase(activeStatus)} ×` : "All statuses"}
            </div>
          </div>

          {/* Table or empty */}
          {subscriptions.length === 0 ? (
            <div style={{ padding: "48px 24px" }}>
              <EmptyState
                heading="No subscriptions found"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <Text as="p" tone="subdued">Try adjusting your filters or search query.</Text>
              </EmptyState>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: "22%" }} />
                  <col style={{ width: "18%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "9%"  }} />
                  <col style={{ width: "9%"  }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "6%"  }} />
                </colgroup>
                <thead>
                  <tr>
                    {["Customer", "Product", "Plan", "Status", "Price", "Frequency", "Next billing", ""].map((h, i) => (
                      <th key={i} style={th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.map((s, i) => {
                    const isLast = i === subscriptions.length - 1;
                    const cell   = isLast ? tdLast : td;
                    return (
                      <tr
                        key={s.id}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--p-color-bg-surface-hover)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        style={{ transition: "background 0.1s", cursor: "pointer" }}
                        onClick={() => navigate(`/app/subscriptions-edit/${s.id}`)}
                      >
                        {/* Customer */}
                        <td style={cell}>
                          <div style={{ fontSize: "13px", fontWeight: 500, color: "var(--p-color-text)", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {s.customerEmail || "—"}
                          </div>
                        </td>

                        {/* Product */}
                        <td style={{ ...cell, color: "var(--p-color-text)" }}>
                          {s.productTitle}
                        </td>

                        {/* Plan */}
                        <td style={{ ...cell, color: "var(--p-color-text-subdued)", fontSize: "12px" }}>
                          {s.planName}
                        </td>

                        {/* Status */}
                        <td style={cell}>{statusPill(s.status)}</td>

                        {/* Price */}
                        <td style={{ ...cell, fontWeight: 500 }}>
                          ${s.price.toFixed(2)}
                        </td>

                        {/* Frequency */}
                        <td style={{ ...cell, color: "var(--p-color-text-subdued)" }}>
                          {titleCase(s.frequency)}
                        </td>

                        {/* Next billing */}
                        <td style={{ ...cell, color: "var(--p-color-text-subdued)" }}>
                          {new Date(s.nextBillingDate).toLocaleDateString("en-GB", {
                            day: "2-digit", month: "short", year: "numeric",
                          })}
                        </td>

                        {/* Actions */}
                        <td style={{ ...cell, overflow: "visible" }} onClick={(e) => e.stopPropagation()}>
                          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                            {/* View */}
                            <button
                              onClick={() => navigate(`/app/subscriptions-edit/${s.id}`)}
                              style={{
                                fontSize:     "12px",
                                padding:      "5px 10px",
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

                            {/* Pause */}
                            {s.status === "ACTIVE" && (
                              <button
                                onClick={() => quickStatus(s.id, "PAUSED")}
                                style={{
                                  fontSize:     "12px",
                                  padding:      "5px 10px",
                                  border:       "0.5px solid #F09595",
                                  borderRadius: "7px",
                                  background:   "var(--p-color-bg-surface)",
                                  color:        "#A32D2D",
                                  cursor:       "pointer",
                                  whiteSpace:   "nowrap",
                                }}
                              >
                                Pause
                              </button>
                            )}

                            {/* Resume */}
                            {(s.status === "PAUSED" || s.status === "FAILED") && (
                              <button
                                onClick={() => quickStatus(s.id, "ACTIVE")}
                                style={{
                                  fontSize:     "12px",
                                  padding:      "5px 10px",
                                  border:       `0.5px solid #AFA9EC`,
                                  borderRadius: "7px",
                                  background:   T.purpleBg,
                                  color:        T.purpleFg,
                                  cursor:       "pointer",
                                  whiteSpace:   "nowrap",
                                }}
                              >
                                Resume
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Pagination ───────────────────────────────── */}
          {totalPages > 1 && (
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
                Page {page} of {totalPages} · {total} subscriptions
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
                    color:        page <= 1 ? "var(--p-color-text-disabled)" : "var(--p-color-text)",
                    fontSize:     "12px",
                    cursor:       page <= 1 ? "not-allowed" : "pointer",
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
                    color:        page >= totalPages ? "var(--p-color-text-disabled)" : "var(--p-color-text)",
                    fontSize:     "12px",
                    cursor:       page >= totalPages ? "not-allowed" : "pointer",
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
