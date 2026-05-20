// app/routes/app._index.tsx

import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { useState } from "react";
import {
  Page,
  BlockStack,
  InlineStack,
  Box,
  Text,
  Button,
  Badge,
  Divider,
  EmptyState,
  Banner,
  Pagination,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { syncSubscriptionsFromShopify } from "../shopify/subscriptionContracts.server";

const PAGE_SIZE = 8;

type ShapedContract = {
  id: string;
  shortId: string;
  customerEmail: string;
  productTitle: string;
  planName: string;
  status: string;
  price: string;
  nextBillingDate: string;
};

type BadgeTone = "success" | "warning" | "critical" | "info";

// ─── Loader ──────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  let fetchError: string | null = null;
  let liveContracts: ShapedContract[] = [];

  try {
    await syncSubscriptionsFromShopify(admin, shop);
  } catch (err: any) {
    console.warn(`[dashboard] subscription sync failed for ${shop}:`, err?.message ?? err);
  }

  try {
    const response = await admin.graphql(
      `#graphql
      query getSubscriptionContracts($first: Int!) {
        subscriptionContracts(first: $first) {
          edges {
            node {
              id
              status
              nextBillingDate
              createdAt
              customer { email }
              lines(first: 1) {
                edges {
                  node {
                    title
                    currentPrice { amount currencyCode }
                    sellingPlanName
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { first: 250 } },
    );

    const result = await response.json();
    if (result?.errors?.length) {
      fetchError = result.errors.map((e: any) => e.message).join(" | ");
    } else {
      liveContracts = (result?.data?.subscriptionContracts?.edges ?? []).map(
        (e: any) => {
          const c = e.node;
          const line = c.lines.edges[0]?.node;
          return {
            id: c.id,
            shortId: c.id.split("/").pop() ?? c.id,
            customerEmail: c.customer?.email ?? "—",
            productTitle: line?.title ?? "—",
            planName: line?.sellingPlanName ?? "Subscription",
            status: c.status,
            price: line?.currentPrice
              ? `${line.currentPrice.currencyCode} ${parseFloat(line.currentPrice.amount).toFixed(2)}`
              : "—",
            nextBillingDate: c.nextBillingDate
              ? new Date(c.nextBillingDate).toLocaleDateString("en-GB", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })
              : "—",
          };
        },
      );
    }
  } catch (err: any) {
    fetchError = `Failed to fetch: ${err?.message ?? String(err)}`;
  }

  const dbSubs =
    liveContracts.length === 0
      ? await db.subscription.findMany({
          where: { shop },
          orderBy: { createdAt: "desc" },
          take: 250,
        })
      : [];

  const contracts: ShapedContract[] =
    liveContracts.length > 0
      ? liveContracts
      : dbSubs.map((s) => ({
          id: s.id,
          shortId: s.id.slice(-6),
          customerEmail: s.customerEmail,
          productTitle: s.productTitle,
          planName: s.planName,
          status: s.status,
          price: `INR ${s.price.toFixed(2)}`,
          nextBillingDate: s.nextBillingDate.toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          }),
        }));

  const active    = contracts.filter((c) => c.status === "ACTIVE").length;
  const paused    = contracts.filter((c) => c.status === "PAUSED").length;
  const cancelled = contracts.filter(
    (c) => c.status === "CANCELLED" || c.status === "EXPIRED",
  ).length;

  return {
    shop,
    stats: { total: contracts.length, active, paused, cancelled },
    contracts,
    fetchError,
  };
}

// ─── Helpers ─────────────────────────────────────────────────
function statusTone(s: string): BadgeTone {
  const map: Record<string, BadgeTone> = {
    ACTIVE: "success",
    PAUSED: "warning",
    CANCELLED: "critical",
    EXPIRED: "critical",
    FAILED: "critical",
    PENDING: "info",
  };
  return map[s] ?? "info";
}

function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ─── Stat Card ───────────────────────────────────────────────
function StatCard({
  label,
  value,
  sub,
  accentColor,
  badgeBg,
  badgeColor,
}: {
  label: string;
  value: number | string;
  sub: string;
  accentColor: string;
  badgeBg: string;
  badgeColor: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        background: "var(--p-color-bg-surface)",
        border: "0.5px solid var(--p-color-border)",
        borderRadius: "14px",
        padding: "18px 20px",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Left accent bar */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "3px",
          height: "100%",
          background: accentColor,
          borderRadius: "14px 0 0 14px",
        }}
      />
      <BlockStack gap="200">
        <Text as="p" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text as="p" variant="heading2xl" fontWeight="bold">
          {value}
        </Text>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            fontSize: "11px",
            fontWeight: 500,
            padding: "3px 9px",
            background: badgeBg,
            color: badgeColor,
            borderRadius: "20px",
            width: "fit-content",
          }}
        >
          <span
            style={{
              width: "5px",
              height: "5px",
              borderRadius: "50%",
              background: accentColor,
              display: "inline-block",
              flexShrink: 0,
            }}
          />
          {sub}
        </div>
      </BlockStack>
    </div>
  );
}

// ─── Contracts Table ─────────────────────────────────────────
function ContractsTable({ contracts }: { contracts: ShapedContract[] }) {
  const [page, setPage] = useState(1);
  const totalPages = Math.ceil(contracts.length / PAGE_SIZE);
  const start      = (page - 1) * PAGE_SIZE;
  const pageRows   = contracts.slice(start, start + PAGE_SIZE);

  const th: React.CSSProperties = {
    padding: "11px 22px",
    textAlign: "left",
    fontSize: "11px",
    fontWeight: 500,
    color: "var(--p-color-text-subdued)",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    background: "var(--p-color-bg-surface-secondary)",
    borderBottom: "0.5px solid var(--p-color-border)",
    whiteSpace: "nowrap",
  };

  const td: React.CSSProperties = {
    padding: "14px 22px",
    verticalAlign: "middle",
    borderBottom: "0.5px solid var(--p-color-border-secondary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "13px",
    color: "var(--p-color-text)",
  };

  const tdLast: React.CSSProperties = { ...td, borderBottom: "none" };

  return (
    <BlockStack gap="0">
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            tableLayout: "fixed",
          }}
        >
          <colgroup>
            <col style={{ width: "25%" }} />
            <col style={{ width: "20%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "15%" }} />
          </colgroup>
          <thead>
            <tr>
              {["Customer", "Product", "Plan", "Status", "Price", "Next billing"].map(
                (h, i) => (
                  <th key={i} style={th}>
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((c, i) => {
              const isLast = i === pageRows.length - 1;
              const cell   = isLast ? tdLast : td;
              return (
                <tr
                  key={c.id}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background =
                      "var(--p-color-bg-surface-hover)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                  style={{ transition: "background 0.1s" }}
                >
                  {/* Customer */}
                  <td style={cell}>
                    <BlockStack gap="025">
                      <Text as="span" variant="bodySm" fontWeight="semibold">
                        {c.customerEmail}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        #{c.shortId}
                      </Text>
                    </BlockStack>
                  </td>

                  {/* Product */}
                  <td style={cell}>
                    <Text as="span" variant="bodySm">
                      {c.productTitle}
                    </Text>
                  </td>

                  {/* Plan */}
                  <td
                    style={{
                      ...cell,
                      color: "var(--p-color-text-subdued)",
                      fontSize: "12px",
                    }}
                  >
                    {c.planName}
                  </td>

                  {/* Status */}
                  <td style={cell}>
                    <Badge tone={statusTone(c.status)}>
                      {titleCase(c.status)}
                    </Badge>
                  </td>

                  {/* Price */}
                  <td style={{ ...cell, fontWeight: 500 }}>{c.price}</td>

                  {/* Next billing */}
                  <td
                    style={{
                      ...cell,
                      color: "var(--p-color-text-subdued)",
                    }}
                  >
                    {c.nextBillingDate}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <>
          <Divider />
          <Box paddingBlock="300" paddingInline="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" variant="bodySm" tone="subdued">
                {start + 1}–{Math.min(start + PAGE_SIZE, contracts.length)} of{" "}
                {contracts.length}
              </Text>
              <InlineStack gap="150" blockAlign="center">
                {/* Numbered page pills */}
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .slice(Math.max(0, page - 2), Math.min(totalPages, page + 1))
                  .map((p) => (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      style={{
                        width: "30px",
                        height: "30px",
                        borderRadius: "8px",
                        border: "0.5px solid var(--p-color-border)",
                        background:
                          p === page
                            ? "#26215C"
                            : "var(--p-color-bg-surface)",
                        color:
                          p === page ? "#EEEDFE" : "var(--p-color-text-subdued)",
                        fontSize: "13px",
                        cursor: "pointer",
                        fontWeight: p === page ? 500 : 400,
                      }}
                    >
                      {p}
                    </button>
                  ))}
                <Pagination
                  hasPrevious={page > 1}
                  hasNext={page < totalPages}
                  onPrevious={() => setPage((p) => p - 1)}
                  onNext={() => setPage((p) => p + 1)}
                />
              </InlineStack>
            </InlineStack>
          </Box>
        </>
      )}
    </BlockStack>
  );
}

// ─── Page Component ──────────────────────────────────────────
export default function Index() {
  const { stats, contracts, fetchError } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const safeTotal      = stats.total || 1;
  const activeRatio    = Math.round((stats.active    / safeTotal) * 100);
  const pausedRatio    = Math.round((stats.paused    / safeTotal) * 100);
  const cancelledRatio = Math.round((stats.cancelled / safeTotal) * 100);

  return (
    <Page>
      <TitleBar title="Subscriptions" />

      <BlockStack gap="600">

        {/* Error banner */}
        {fetchError && (
          <Banner title="Could not load contracts" tone="critical">
            <Text as="p" variant="bodySm">
              {fetchError}
            </Text>
          </Banner>
        )}

        {/* ── Page header ───────────────────────────────── */}
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            {/* Breadcrumb */}
            <InlineStack gap="150" blockAlign="center">
              <span
                style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  background: "#7F77DD",
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              <Text as="span" variant="bodySm" tone="subdued">
                KAS Subscription › Dashboard
              </Text>
            </InlineStack>
            <Text as="h1" variant="headingXl" fontWeight="bold">
              Subscriptions
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Overview of all subscription contracts
            </Text>
          </BlockStack>

          <InlineStack gap="200">
            <Button onClick={() => navigate("/app/analytics")}>
              Analytics
            </Button>
            <Button variant="primary" onClick={() => navigate("/app/plans")}>
              Manage plans
            </Button>
          </InlineStack>
        </InlineStack>

        {/* ── Stat cards ───────────────────────────────── */}
        <div style={{ display: "flex", gap: "14px" }}>
          <StatCard
            label="Total"
            value={stats.total}
            sub="All statuses"
            accentColor="#7F77DD"
            badgeBg="#EEEDFE"
            badgeColor="#3C3489"
          />
          <StatCard
            label="Active"
            value={stats.active}
            sub={`${activeRatio}% of total`}
            accentColor="#639922"
            badgeBg="#EAF3DE"
            badgeColor="#27500A"
          />
          <StatCard
            label="Paused"
            value={stats.paused}
            sub={`${pausedRatio}% of total`}
            accentColor="#BA7517"
            badgeBg="#FAEEDA"
            badgeColor="#633806"
          />
          <StatCard
            label="Cancelled"
            value={stats.cancelled}
            sub={`${cancelledRatio}% of total`}
            accentColor="#E24B4A"
            badgeBg="#FCEBEB"
            badgeColor="#791F1F"
          />
        </div>

        {/* ── Contracts table card ──────────────────────── */}
        <div
          style={{
            background: "var(--p-color-bg-surface)",
            border: "0.5px solid var(--p-color-border)",
            borderRadius: "14px",
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <Box paddingInline="400" paddingBlock="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="050">
                <InlineStack gap="200" blockAlign="center">
                  <span
                    style={{
                      width: "7px",
                      height: "7px",
                      borderRadius: "50%",
                      background: "#3B6D11",
                      display: "inline-block",
                      flexShrink: 0,
                    }}
                  />
                  <Text as="h2" variant="headingMd" fontWeight="bold">
                    Active contracts
                  </Text>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  {stats.total} total · synced live from Shopify API
                </Text>
              </BlockStack>
              <Button onClick={() => navigate("/app/subscriptions")}>
                View all →
              </Button>
            </InlineStack>
          </Box>

          <Divider />

          {contracts.length === 0 && !fetchError ? (
            <Box padding="600">
              <EmptyState
                heading="No subscription contracts yet"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                action={{
                  content: "Create selling plan",
                  onAction: () => navigate("/app/plans"),
                }}
              >
                <Text as="p" tone="subdued">
                  Contracts appear once a customer subscribes at checkout.
                </Text>
              </EmptyState>
            </Box>
          ) : (
            <ContractsTable contracts={contracts} />
          )}
        </div>

      </BlockStack>
    </Page>
  );
}
