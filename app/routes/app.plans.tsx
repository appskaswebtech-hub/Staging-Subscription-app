// app/routes/app.plans.tsx

import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useLoaderData,
  useSubmit,
  useNavigation,
  useActionData,
} from "@remix-run/react";
import { useState, useEffect, useCallback } from "react";
import {
  Page,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Modal,
  TextField,
  Select,
  Banner,
  Toast,
  Frame,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getFirstSellingPlanId } from "../shopify/sellingPlans.server";

// ─── Types ────────────────────────────────────────────────────
type ProductEdge = {
  node: {
    id: string;
    title: string;
    featuredImage: { url: string } | null;
    sellingPlanGroupCount: number;
  };
};

type PickerProduct = {
  id: string;
  title: string;
  image: string | null;
};

type PlanGroup = {
  id: string;
  shopifyGroupId: string | null;
  name: string;
  interval: string;
  intervalCount: number;
  discount: number;
  createdAt: string;
  productCount?: number;
  products?: Array<{ id: string; title: string; image: string | null }>;
};

type PlanFormValues = {
  name: string;
  interval: string;
  intervalCount: string;
  discount: string;
};

type ShopTier = "free" | "basic" | "pro" | "advanced";

// ─── Plan tier limits ─────────────────────────────────────────
const PLAN_LIMITS: Record<ShopTier, number> = {
  free: 1,
  basic: 2,
  pro: 3,
  advanced: Infinity,
};

const PLAN_LABELS: Record<ShopTier, string> = {
  free: "Free",
  basic: "Basic",
  pro: "Pro",
  advanced: "Advanced",
};

function getPlanLimit(tier: string): number {
  return PLAN_LIMITS[tier as ShopTier] ?? 1;
}

function getPlanLabel(tier: string): string {
  return PLAN_LABELS[tier as ShopTier] ?? "Free";
}

// ─── Design tokens ───────────────────────────────────────────
const T = {
  purple: "#7F77DD",
  purpleBg: "#EEEDFE",
  purpleMid: "#534AB7",
  purpleDark: "#26215C",
  purpleFg: "#3C3489",
  greenBg: "#EAF3DE",
  greenFg: "#27500A",
  greenDot: "#3B6D11",
  amberBg: "#FAEEDA",
  amberFg: "#633806",
  amberDot: "#BA7517",
  redBg: "#FCEBEB",
  redFg: "#791F1F",
  redBorder: "#F09595",
  tealBg: "#E1F5EE",
  tealStroke: "#0F6E56",
};

const INTERVAL_OPTIONS = [
  { label: "Daily", value: "DAY" },
  { label: "Weekly", value: "WEEK" },
  { label: "Monthly", value: "MONTH" },
  { label: "Yearly", value: "YEAR" },
] as const;

function defaultPlanFormValues(): PlanFormValues {
  return {
    name: "Monthly Subscription",
    interval: "MONTH",
    intervalCount: "1",
    discount: "10",
  };
}

function formatIntervalLabel(interval: string, intervalCount: number) {
  return `Every ${intervalCount} ${
    interval.charAt(0) + interval.slice(1).toLowerCase()
  }${intervalCount > 1 ? "s" : ""}`;
}

function merchantCode(name: string) {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function parsePlanForm(formData: FormData) {
  const name = (formData.get("name") as string | null)?.trim() ?? "";
  const interval = (formData.get("interval") as string | null) ?? "";
  const intervalCount = Number.parseInt(
    (formData.get("intervalCount") as string | null) ?? "",
    10,
  );
  const discount = Number.parseFloat(
    (formData.get("discount") as string | null) ?? "0",
  );

  if (!name) return { error: "Plan name is required." };
  if (!INTERVAL_OPTIONS.some((o) => o.value === interval))
    return { error: "Select a valid billing interval." };
  if (!Number.isInteger(intervalCount) || intervalCount < 1)
    return { error: "Interval count must be at least 1." };
  if (Number.isNaN(discount) || discount < 0 || discount > 100)
    return { error: "Discount must be between 0 and 100." };

  return { name, interval, intervalCount, discount };
}

function buildSellingPlanPayload({
  name,
  interval,
  intervalCount,
  discount,
}: {
  name: string;
  interval: string;
  intervalCount: number;
  discount: number;
}) {
  const optionLabel = formatIntervalLabel(interval, intervalCount);
  const planName =
    discount > 0 ? `${optionLabel} (${discount}% off)` : optionLabel;

  const sellingPlanInput = {
    name: planName,
    options: optionLabel,
    category: "SUBSCRIPTION",
    billingPolicy: { recurring: { interval, intervalCount } },
    deliveryPolicy: { recurring: { interval, intervalCount } },
    pricingPolicies:
      discount > 0
        ? [
            {
              fixed: {
                adjustmentType: "PERCENTAGE",
                adjustmentValue: { percentage: discount },
              },
            },
          ]
        : [],
  };

  return {
    groupInput: {
      name,
      merchantCode: merchantCode(name),
      options: [optionLabel],
    },
    sellingPlanInput,
  };
}

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);

  const shopPlan = await prisma.shopPlan.findUnique({
    where: { shop: session.shop },
  });
  const tier = (shopPlan?.plan ?? "free") as ShopTier;
  const planLimit = getPlanLimit(tier);

  const localGroups = await prisma.sellingPlanGroup.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });

  const enriched = await Promise.all(
    localGroups.map(async (g) => {
      if (!g.shopifyGroupId) return { ...g, productCount: 0, products: [] };
      try {
        const res = await admin.graphql(
          `#graphql
          query getSellingPlanGroupProducts($id: ID!) {
            sellingPlanGroup(id: $id) {
              productsCount { count }
              products(first: 50) {
                edges {
                  node { id title featuredImage { url } }
                }
              }
            }
          }`,
          { variables: { id: g.shopifyGroupId } },
        );
        const result = await res.json();
        const spg = result?.data?.sellingPlanGroup;
        return {
          ...g,
          productCount: spg?.productsCount?.count ?? 0,
          products: (spg?.products?.edges ?? []).map((e: ProductEdge) => ({
            id: e.node.id,
            title: e.node.title,
            image: e.node.featuredImage?.url ?? null,
          })),
        };
      } catch {
        return { ...g, productCount: 0, products: [] };
      }
    }),
  );

  // ── Fetch all store products for the picker (server-side, authenticated) ──
  let allProducts: PickerProduct[] = [];
  try {
    const productsRes = await admin.graphql(
      `#graphql
      query getAllProducts {
        products(first: 100) {
          edges {
            node {
              id
              title
              featuredImage { url }
            }
          }
        }
      }`,
    );
    const productsResult = await productsRes.json();
    allProducts = (productsResult?.data?.products?.edges ?? []).map(
      (e: any) => ({
        id: e.node.id,
        title: e.node.title,
        image: e.node.featuredImage?.url ?? null,
      }),
    );
  } catch {
    allProducts = [];
  }

  return json({
    planGroups: enriched as PlanGroup[],
    shopTier: tier,
    planLimit,
    planLabel: getPlanLabel(tier),
    allProducts,
  });
}

// ─── Action ───────────────────────────────────────────────────
export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // ── Create ─────────────────────────────────────────────────
  if (intent === "create") {
    const shopPlan = await prisma.shopPlan.findUnique({
      where: { shop: session.shop },
    });
    const tier = shopPlan?.plan ?? "free";
    const limit = getPlanLimit(tier);
    const currentCount = await prisma.sellingPlanGroup.count({
      where: { shop: session.shop },
    });

    if (currentCount >= limit) {
      const limitLabel = limit === Infinity ? "unlimited" : `${limit}`;
      return json(
        {
          ok: false,
          error: `Your ${getPlanLabel(tier)} plan allows up to ${limitLabel} selling plan${limit === 1 ? "" : "s"}. Upgrade to create more.`,
          intent: "create",
          limitReached: true,
        },
        { status: 403 },
      );
    }

    const parsed = parsePlanForm(formData);
    if ("error" in parsed) {
      return json(
        { ok: false, error: parsed.error, intent: "create" },
        { status: 422 },
      );
    }

    const { name, interval, intervalCount, discount } = parsed;
    const { groupInput, sellingPlanInput } = buildSellingPlanPayload({
      name,
      interval,
      intervalCount,
      discount,
    });
    const { pricingPolicies, ...sellingPlanWithoutPolicies } = sellingPlanInput;

    let response;
    try {
      response = await admin.graphql(
        `#graphql
        mutation sellingPlanGroupCreate(
          $input: SellingPlanGroupInput!
          $resources: SellingPlanGroupResourceInput
        ) {
          sellingPlanGroupCreate(input: $input, resources: $resources) {
            sellingPlanGroup {
              id name
              sellingPlans(first: 5) { edges { node { id name } } }
            }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            input: {
              ...groupInput,
              sellingPlansToCreate: [
                discount > 0 ? sellingPlanInput : sellingPlanWithoutPolicies,
              ],
            },
            resources: { productIds: [], productVariantIds: [] },
          },
        },
      );
    } catch (err: any) {
      return json({ ok: false, error: `Request failed: ${err?.message}` });
    }

    const result = await response.json();

    if (result?.errors?.length)
      return json({
        ok: false,
        error: result.errors.map((e: any) => e.message).join(" | "),
      });

    const userErrors = result?.data?.sellingPlanGroupCreate?.userErrors ?? [];
    if (userErrors.length)
      return json({
        ok: false,
        error: userErrors
          .map((e: any) => `[${e.field}] ${e.message}`)
          .join(" | "),
      });

    const groupId =
      result?.data?.sellingPlanGroupCreate?.sellingPlanGroup?.id;
    if (!groupId)
      return json({
        ok: false,
        error:
          "No group ID returned. Check write_products + write_purchase_options scopes.",
      });

    await prisma.sellingPlanGroup.create({
      data: {
        shop: session.shop,
        shopifyGroupId: groupId,
        name,
        interval,
        intervalCount,
        discount,
      },
    });

    return json({ ok: true, error: null, intent: "create" });
  }

  // ── Update ─────────────────────────────────────────────────
  if (intent === "update") {
    const id = formData.get("id") as string;
    const group = await prisma.sellingPlanGroup.findFirst({
      where: { id, shop: session.shop },
    });

    if (!group) {
      return json(
        { ok: false, error: "Plan not found.", intent: "update" },
        { status: 404 },
      );
    }

    const parsed = parsePlanForm(formData);
    if ("error" in parsed) {
      return json(
        { ok: false, error: parsed.error, intent: "update" },
        { status: 422 },
      );
    }

    const { name, interval, intervalCount, discount } = parsed;
    const { groupInput, sellingPlanInput } = buildSellingPlanPayload({
      name,
      interval,
      intervalCount,
      discount,
    });

    if (group.shopifyGroupId) {
      let sellingPlanId: string | null = null;
      try {
        sellingPlanId = await getFirstSellingPlanId(
          admin.graphql,
          group.shopifyGroupId,
        );
      } catch (err: any) {
        return json({
          ok: false,
          error: `Could not load the Shopify selling plan: ${err?.message}`,
          intent: "update",
        });
      }

      if (!sellingPlanId) {
        return json({
          ok: false,
          error: "No Shopify selling plan was found for this group.",
          intent: "update",
        });
      }

      let response;
      try {
        response = await admin.graphql(
          `#graphql
          mutation sellingPlanGroupUpdate($id: ID!, $input: SellingPlanGroupInput!) {
            sellingPlanGroupUpdate(id: $id, input: $input) {
              sellingPlanGroup { id }
              userErrors { field message }
            }
          }`,
          {
            variables: {
              id: group.shopifyGroupId,
              input: {
                ...groupInput,
                sellingPlansToUpdate: [
                  { id: sellingPlanId, ...sellingPlanInput },
                ],
              },
            },
          },
        );
      } catch (err: any) {
        return json({
          ok: false,
          error: `Update failed: ${err?.message}`,
          intent: "update",
        });
      }

      const result = await response.json();

      if (result?.errors?.length) {
        return json({
          ok: false,
          error: result.errors.map((e: any) => e.message).join(" | "),
          intent: "update",
        });
      }

      const userErrors =
        result?.data?.sellingPlanGroupUpdate?.userErrors ?? [];
      if (userErrors.length) {
        return json({
          ok: false,
          error: userErrors
            .map((e: any) => `[${e.field}] ${e.message}`)
            .join(" | "),
          intent: "update",
        });
      }
    }

    await prisma.sellingPlanGroup.update({
      where: { id },
      data: { name, interval, intervalCount, discount },
    });

    return json({ ok: true, error: null, intent: "update" });
  }

  // ── Assign products bulk ────────────────────────────────────
  if (intent === "assign_products_bulk") {
    const shopifyGroupId = formData.get("shopifyGroupId") as string;
    const productIds = formData.getAll("productId[]") as string[];

    if (!productIds.length) {
      return json({
        ok: false,
        error: "No products selected.",
        intent: "assign_products_bulk",
      });
    }

    try {
      const response = await admin.graphql(
        `#graphql
        mutation sellingPlanGroupAddProducts($id: ID!, $productIds: [ID!]!) {
          sellingPlanGroupAddProducts(id: $id, productIds: $productIds) {
            sellingPlanGroup { id name }
            userErrors { field message }
          }
        }`,
        { variables: { id: shopifyGroupId, productIds } },
      );
      const result = await response.json();
      const userErrors =
        result?.data?.sellingPlanGroupAddProducts?.userErrors ?? [];
      if (userErrors.length) {
        return json({
          ok: false,
          error: userErrors.map((e: any) => e.message).join(" | "),
          intent: "assign_products_bulk",
        });
      }
    } catch (err: any) {
      return json({
        ok: false,
        error: `Assign failed: ${err?.message}`,
        intent: "assign_products_bulk",
      });
    }

    return json({ ok: true, error: null, intent: "assign_products_bulk" });
  }

  // ── Remove product ─────────────────────────────────────────
  if (intent === "remove_product") {
    const shopifyGroupId = formData.get("shopifyGroupId") as string;
    const productId = formData.get("productId") as string;
    try {
      await admin.graphql(
        `#graphql
        mutation sellingPlanGroupRemoveProducts($id: ID!, $productIds: [ID!]!) {
          sellingPlanGroupRemoveProducts(id: $id, productIds: $productIds) {
            removedProductIds
            userErrors { field message }
          }
        }`,
        { variables: { id: shopifyGroupId, productIds: [productId] } },
      );
    } catch (err: any) {
      return json({ ok: false, error: `Remove failed: ${err?.message}` });
    }
    return json({ ok: true, error: null, intent: "remove_product" });
  }

  // ── Delete ─────────────────────────────────────────────────
  if (intent === "delete") {
    const id = formData.get("id") as string;
    const group = await prisma.sellingPlanGroup.findFirst({
      where: { id, shop: session.shop },
    });
    if (group?.shopifyGroupId) {
      try {
        await admin.graphql(
          `#graphql
          mutation sellingPlanGroupDelete($id: ID!) {
            sellingPlanGroupDelete(id: $id) {
              deletedSellingPlanGroupId
              userErrors { field message }
            }
          }`,
          { variables: { id: group.shopifyGroupId } },
        );
      } catch (err: any) {
        return json({
          ok: false,
          error: `Delete on Shopify failed: ${err?.message}`,
        });
      }
    }
    await prisma.sellingPlanGroup.delete({ where: { id } });
    return json({ ok: true, error: null, intent: "delete" });
  }

  return json({ ok: false, error: `Unknown intent: ${intent}` });
}

// ─── Plan usage bar ───────────────────────────────────────────
function PlanUsageBar({
  used,
  limit,
  tier,
  planLabel,
}: {
  used: number;
  limit: number;
  tier: string;
  planLabel: string;
}) {
  const isUnlimited = limit === Infinity;
  const pct = isUnlimited ? 0 : Math.min((used / limit) * 100, 100);
  const isFull = !isUnlimited && used >= limit;
  const isNearFull = !isUnlimited && used >= limit - 1 && used < limit;

  const barColor = isFull ? "#C94040" : isNearFull ? T.amberDot : T.purple;
  const bgColor = isFull ? T.redBg : isNearFull ? T.amberBg : T.purpleBg;
  const labelColor = isFull ? T.redFg : isNearFull ? T.amberFg : T.purpleFg;

  const tierBadgeColors: Record<string, { bg: string; fg: string }> = {
    free: { bg: "#F3F3F3", fg: "#555" },
    basic: { bg: T.purpleBg, fg: T.purpleFg },
    pro: { bg: "#E8F4FD", fg: "#1A5F8B" },
    advanced: { bg: "#E6F9F0", fg: "#1A6B45" },
  };
  const badge = tierBadgeColors[tier] ?? tierBadgeColors.free;

  return (
    <div
      style={{
        background: bgColor,
        border: `0.5px solid ${isFull ? T.redBorder : isNearFull ? "#E8C97A" : "#AFA9EC"}`,
        borderRadius: "12px",
        padding: "14px 18px",
        display: "flex",
        gap: "16px",
        alignItems: "center",
      }}
    >
      <div
        style={{
          width: "36px",
          height: "36px",
          borderRadius: "10px",
          background: isFull ? T.redBg : T.purpleBg,
          border: `0.5px solid ${isFull ? T.redBorder : "#C8C3F2"}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke={isFull ? T.redFg : T.purple}
          strokeWidth="2"
        >
          <path d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" />
        </svg>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "6px",
            gap: "8px",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Text as="span" variant="bodySm" fontWeight="semibold">
              <span style={{ color: labelColor }}>Selling Plans</span>
            </Text>
            <span
              style={{
                fontSize: "10px",
                fontWeight: 600,
                padding: "2px 8px",
                background: badge.bg,
                color: badge.fg,
                borderRadius: "20px",
                letterSpacing: "0.03em",
                textTransform: "uppercase",
              }}
            >
              {planLabel}
            </span>
          </div>
          <Text as="span" variant="bodySm" tone="subdued">
            <span style={{ color: labelColor, fontWeight: 600 }}>{used}</span>
            <span style={{ color: labelColor, opacity: 0.6 }}>
              {" "}/ {isUnlimited ? "∞" : limit}
            </span>
          </Text>
        </div>

        {!isUnlimited && (
          <div
            style={{
              height: "5px",
              borderRadius: "99px",
              background: isFull
                ? "#F5C9C9"
                : isNearFull
                  ? "#F5DFA8"
                  : "#C8C3F2",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${pct}%`,
                background: barColor,
                borderRadius: "99px",
                transition: "width 0.4s ease",
              }}
            />
          </div>
        )}

        <div style={{ marginTop: "5px" }}>
          {isUnlimited ? (
            <Text as="span" variant="bodySm" tone="subdued">
              <span style={{ color: "#1A6B45", fontSize: "12px" }}>
                Unlimited plans on Advanced
              </span>
            </Text>
          ) : isFull ? (
            <Text as="span" variant="bodySm">
              <span style={{ color: T.redFg, fontSize: "12px" }}>
                Limit reached — upgrade your plan to add more
              </span>
            </Text>
          ) : (
            <Text as="span" variant="bodySm" tone="subdued">
              <span style={{ fontSize: "12px" }}>
                {limit - used} slot{limit - used !== 1 ? "s" : ""} remaining
              </span>
            </Text>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Plan Card ────────────────────────────────────────────────
const PRODUCTS_PER_PAGE = 4;

function PlanCard({
  plan,
  isSubmitting,
  onEdit,
  onAssign,
  onRemoveProduct,
  onDelete,
}: {
  plan: PlanGroup;
  isSubmitting: boolean;
  onEdit: (plan: PlanGroup) => void;
  onAssign: (shopifyGroupId: string, localId: string) => void;
  onRemoveProduct: (shopifyGroupId: string, productId: string) => void;
  onDelete: (id: string) => void;
}) {
  const [productPage, setProductPage] = useState(0);

  const intervalLabel = formatIntervalLabel(plan.interval, plan.intervalCount);
  const isSynced = !!plan.shopifyGroupId;
  const allProducts = plan.products ?? [];
  const hasProducts = allProducts.length > 0;
  const noProducts = (plan.productCount ?? 0) === 0;
  const totalPages = Math.ceil(allProducts.length / PRODUCTS_PER_PAGE);
  const pagedProducts = allProducts.slice(
    productPage * PRODUCTS_PER_PAGE,
    (productPage + 1) * PRODUCTS_PER_PAGE,
  );

  const detailRow: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 0",
    borderBottom: `0.5px solid var(--p-color-border-secondary)`,
  };
  const detailRowLast: React.CSSProperties = {
    ...detailRow,
    borderBottom: "none",
  };

  const rows = [
    { label: "Interval", value: intervalLabel, special: null },
    {
      label: "Discount",
      value: plan.discount > 0 ? `${plan.discount}% off` : "None",
      special: "discount",
    },
    {
      label: "Shopify GID",
      value: plan.shopifyGroupId?.split("/").pop() ?? "—",
      special: "muted",
    },
    {
      label: "Products assigned",
      value: String(plan.productCount ?? 0),
      special: noProducts ? "warn" : null,
    },
  ] as const;

  return (
    <div
      style={{
        background: "var(--p-color-bg-surface)",
        border: "0.5px solid var(--p-color-border)",
        borderRadius: "16px",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          padding: "18px 20px 14px",
          borderBottom: "0.5px solid var(--p-color-border)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
          <div
            style={{
              width: "38px",
              height: "38px",
              borderRadius: "10px",
              background: T.purpleBg,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            {plan.interval === "DAY" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={T.purple} strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            ) : plan.interval === "WEEK" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={T.purple} strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
            ) : plan.interval === "YEAR" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={T.purple} strokeWidth="2">
                <path d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={T.purple} strokeWidth="2">
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            )}
          </div>
          <div>
            <Text as="h3" variant="headingMd" fontWeight="bold">
              {plan.name}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {intervalLabel}
              {plan.discount > 0 ? ` · ${plan.discount}% off` : ""}
            </Text>
          </div>
        </div>

        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            fontSize: "11px",
            fontWeight: 500,
            padding: "4px 10px",
            background: isSynced ? T.greenBg : T.amberBg,
            color: isSynced ? T.greenFg : T.amberFg,
            borderRadius: "20px",
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              width: "5px",
              height: "5px",
              borderRadius: "50%",
              background: isSynced ? T.greenDot : T.amberDot,
              display: "inline-block",
            }}
          />
          {isSynced ? "Synced to Shopify" : "Local only"}
        </div>
      </div>

      {/* ── Detail rows ── */}
      <div style={{ padding: "4px 20px" }}>
        {rows.map(({ label, value, special }, i) => (
          <div
            key={label}
            style={i === rows.length - 1 ? detailRowLast : detailRow}
          >
            <Text as="span" variant="bodySm" tone="subdued">
              {label}
            </Text>
            {special === "warn" ? (
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 500,
                  color: T.redFg,
                  background: T.redBg,
                  padding: "2px 8px",
                  borderRadius: "20px",
                }}
              >
                0 — assign a product
              </span>
            ) : special === "discount" && plan.discount > 0 ? (
              <span style={{ fontSize: "13px", fontWeight: 500, color: T.greenFg }}>
                {value}
              </span>
            ) : special === "muted" ? (
              <Text as="span" variant="bodySm" tone="subdued">
                {value}
              </Text>
            ) : (
              <Text as="span" variant="bodySm" fontWeight="semibold">
                {value}
              </Text>
            )}
          </div>
        ))}
      </div>

      {/* ── Assigned products with pagination ── */}
      {hasProducts && (
        <>
          <div
            style={{
              padding: "8px 20px 6px",
              background: "var(--p-color-bg-surface-secondary)",
              borderTop: "0.5px solid var(--p-color-border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Text as="p" variant="bodySm" tone="subdued">
              Assigned products
            </Text>
            {totalPages > 1 && (
              <span style={{ fontSize: "11px", color: T.purpleFg, fontWeight: 500 }}>
                {productPage + 1} / {totalPages}
              </span>
            )}
          </div>

          <div
            style={{
              padding: "8px 20px 14px",
              background: "var(--p-color-bg-surface-secondary)",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            {pagedProducts.map((product) => (
              <div
                key={product.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  padding: "10px 12px",
                  background: "var(--p-color-bg-surface)",
                  border: "0.5px solid var(--p-color-border)",
                  borderRadius: "10px",
                }}
              >
                <div
                  style={{
                    width: "34px",
                    height: "34px",
                    borderRadius: "8px",
                    background: T.tealBg,
                    overflow: "hidden",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {product.image ? (
                    <img
                      src={product.image}
                      alt={product.title}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.tealStroke} strokeWidth="2">
                      <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
                      <line x1="3" y1="6" x2="21" y2="6" />
                    </svg>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text as="p" variant="bodySm" fontWeight="semibold">
                    {product.title}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {product.id.split("/").pop()}
                  </Text>
                </div>
                <button
                  onClick={() => onRemoveProduct(plan.shopifyGroupId!, product.id)}
                  disabled={isSubmitting}
                  style={{
                    fontSize: "12px",
                    padding: "5px 12px",
                    border: `0.5px solid ${T.redBorder}`,
                    borderRadius: "8px",
                    background: "var(--p-color-bg-surface)",
                    color: "#A32D2D",
                    cursor: "pointer",
                    flexShrink: 0,
                    opacity: isSubmitting ? 0.6 : 1,
                  }}
                >
                  Remove
                </button>
              </div>
            ))}

            {/* Pagination controls */}
            {totalPages > 1 && (
              <div style={{ display: "flex", gap: "6px", justifyContent: "center", marginTop: "4px" }}>
                <button
                  onClick={() => setProductPage((p) => Math.max(0, p - 1))}
                  disabled={productPage === 0}
                  style={{
                    padding: "5px 12px",
                    fontSize: "12px",
                    borderRadius: "8px",
                    border: `0.5px solid #C8C3F2`,
                    background: productPage === 0 ? "var(--p-color-bg-surface-disabled)" : "var(--p-color-bg-surface)",
                    color: productPage === 0 ? "var(--p-color-text-disabled)" : T.purpleFg,
                    cursor: productPage === 0 ? "not-allowed" : "pointer",
                  }}
                >
                  ← Prev
                </button>
                {Array.from({ length: totalPages }, (_, i) => (
                  <button
                    key={i}
                    onClick={() => setProductPage(i)}
                    style={{
                      width: "28px",
                      height: "28px",
                      fontSize: "12px",
                      borderRadius: "8px",
                      border: `0.5px solid ${i === productPage ? T.purple : "#C8C3F2"}`,
                      background: i === productPage ? T.purpleBg : "var(--p-color-bg-surface)",
                      color: i === productPage ? T.purpleFg : "var(--p-color-text-subdued)",
                      cursor: "pointer",
                      fontWeight: i === productPage ? 600 : 400,
                    }}
                  >
                    {i + 1}
                  </button>
                ))}
                <button
                  onClick={() => setProductPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={productPage === totalPages - 1}
                  style={{
                    padding: "5px 12px",
                    fontSize: "12px",
                    borderRadius: "8px",
                    border: `0.5px solid #C8C3F2`,
                    background: productPage === totalPages - 1 ? "var(--p-color-bg-surface-disabled)" : "var(--p-color-bg-surface)",
                    color: productPage === totalPages - 1 ? "var(--p-color-text-disabled)" : T.purpleFg,
                    cursor: productPage === totalPages - 1 ? "not-allowed" : "pointer",
                  }}
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Footer actions ── */}
      <div
        style={{
          display: "flex",
          gap: "8px",
          padding: "14px 20px",
          borderTop: "0.5px solid var(--p-color-border)",
          marginTop: "auto",
        }}
      >
        <button
          onClick={() => onEdit(plan)}
          disabled={isSubmitting}
          style={{
            flex: isSynced ? "0 0 auto" : 1,
            background: "var(--p-color-bg-surface)",
            color: T.purpleFg,
            border: "0.5px solid #C8C3F2",
            padding: "9px 16px",
            borderRadius: "9px",
            fontSize: "13px",
            cursor: "pointer",
            opacity: isSubmitting ? 0.7 : 1,
          }}
        >
          Edit
        </button>
        {isSynced && (
          <button
            onClick={() => onAssign(plan.shopifyGroupId!, plan.id)}
            disabled={isSubmitting}
            style={{
              flex: 1,
              background: T.purpleDark,
              color: T.purpleBg,
              border: "none",
              padding: "9px",
              borderRadius: "9px",
              fontSize: "13px",
              fontWeight: 500,
              cursor: "pointer",
              opacity: isSubmitting ? 0.7 : 1,
            }}
          >
            + Assign product
          </button>
        )}
        <button
          onClick={() => onDelete(plan.id)}
          disabled={isSubmitting}
          style={{
            background: "var(--p-color-bg-surface)",
            color: "#A32D2D",
            border: `0.5px solid ${T.redBorder}`,
            padding: "9px 16px",
            borderRadius: "9px",
            fontSize: "13px",
            cursor: "pointer",
            opacity: isSubmitting ? 0.7 : 1,
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ─── Page component ───────────────────────────────────────────
export default function Plans() {
  const { planGroups, shopTier, planLimit, planLabel, allProducts } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const activeIntent = navigation.formData?.get("intent");
  const isSavingPlan =
    isSubmitting && (activeIntent === "create" || activeIntent === "update");

  const isUnlimited = planLimit === Infinity;
  const atLimit = !isUnlimited && planGroups.length >= planLimit;

  // ── Plan editor modal state ──
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  const [name, setName] = useState(defaultPlanFormValues().name);
  const [interval, setInterval] = useState(defaultPlanFormValues().interval);
  const [intervalCount, setIntervalCount] = useState(
    defaultPlanFormValues().intervalCount,
  );
  const [discount, setDiscount] = useState(defaultPlanFormValues().discount);

  // ── Product picker modal state ──
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const [pickerTargetGroupId, setPickerTargetGroupId] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(
    new Set(),
  );
  const [isAssigning, setIsAssigning] = useState(false);

  // Client-side filter — no extra fetch needed, products loaded in loader
  const filteredProducts = allProducts.filter((p: PickerProduct) =>
    p.title.toLowerCase().includes(productSearch.toLowerCase()),
  );

  // ── Toast state ──
  const [toastActive, setToastActive] = useState(false);
  const [toastMsg, setToastMsg] = useState("");
  const [toastIsError, setToastIsError] = useState(false);

  useEffect(() => {
    if (!actionData) return;
    if (!("ok" in actionData)) return;

    if (actionData.error) {
      setToastMsg(actionData.error);
      setToastIsError(true);
      setToastActive(true);
      setIsAssigning(false);
    } else if (actionData.ok) {
      const msgs: Record<string, string> = {
        create: "Selling plan created!",
        update: "Selling plan updated.",
        assign_products_bulk: "Products assigned to plan!",
        remove_product: "Product removed from plan.",
        delete: "Plan deleted.",
      };
      setToastMsg(msgs[(actionData as any).intent] ?? "Done!");
      setToastIsError(false);
      setToastActive(true);
      setIsAssigning(false);

      if (
        (actionData as any).intent === "create" ||
        (actionData as any).intent === "update"
      ) {
        setEditorOpen(false);
        setEditingPlanId(null);
      }
      if ((actionData as any).intent === "assign_products_bulk") {
        setProductPickerOpen(false);
        setSelectedProductIds(new Set());
      }
    }
  }, [actionData]);

  const openProductPicker = useCallback(
    (shopifyGroupId: string, _localId: string) => {
      setPickerTargetGroupId(shopifyGroupId);
      setProductSearch("");
      setSelectedProductIds(new Set());
      setProductPickerOpen(true);
    },
    [],
  );

  function toggleProductSelection(id: string) {
    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function handleBulkAssign() {
    if (selectedProductIds.size === 0) return;
    setIsAssigning(true);
    const fd = new FormData();
    fd.append("intent", "assign_products_bulk");
    fd.append("shopifyGroupId", pickerTargetGroupId);
    selectedProductIds.forEach((id) => fd.append("productId[]", id));
    submit(fd, { method: "post" });
  }

  function handleCreate() {
    if (!name.trim()) return;
    const fd = new FormData();
    fd.append("intent", editingPlanId ? "update" : "create");
    if (editingPlanId) fd.append("id", editingPlanId);
    fd.append("name", name.trim());
    fd.append("interval", interval);
    fd.append("intervalCount", intervalCount);
    fd.append("discount", discount || "0");
    submit(fd, { method: "post" });
  }

  function handleOpenCreate() {
    if (atLimit) return;
    const defaults = defaultPlanFormValues();
    setEditingPlanId(null);
    setName(defaults.name);
    setInterval(defaults.interval);
    setIntervalCount(defaults.intervalCount);
    setDiscount(defaults.discount);
    setEditorOpen(true);
  }

  function handleOpenEdit(plan: PlanGroup) {
    setEditingPlanId(plan.id);
    setName(plan.name);
    setInterval(plan.interval);
    setIntervalCount(plan.intervalCount.toString());
    setDiscount(plan.discount.toString());
    setEditorOpen(true);
  }

  function handleCloseEditor() {
    setEditorOpen(false);
    setEditingPlanId(null);
  }

  function handleRemoveProduct(shopifyGroupId: string, productId: string) {
    const fd = new FormData();
    fd.append("intent", "remove_product");
    fd.append("shopifyGroupId", shopifyGroupId);
    fd.append("productId", productId);
    submit(fd, { method: "post" });
  }

  function handleDelete(id: string) {
    if (!confirm("Delete this selling plan from Shopify?")) return;
    const fd = new FormData();
    fd.append("intent", "delete");
    fd.append("id", id);
    submit(fd, { method: "post" });
  }

  return (
    <Frame>
      <Page>
        <TitleBar title="Selling Plans" />

        <BlockStack gap="600">
          {/* ── Page header ── */}
          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <InlineStack gap="150" blockAlign="center">
                <span
                  style={{
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    background: T.purple,
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                <Text as="span" variant="bodySm" tone="subdued">
                  KAS Subscription › Selling Plans
                </Text>
              </InlineStack>
              <Text as="h1" variant="headingXl" fontWeight="bold">
                Selling plans
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {planGroups.length} plan{planGroups.length !== 1 ? "s" : ""}{" "}
                configured
              </Text>
            </BlockStack>

            <div style={{ position: "relative" }}>
              {atLimit ? (
                <button
                  disabled
                  title={`Upgrade from ${planLabel} to create more plans`}
                  style={{
                    background: "var(--p-color-bg-surface-disabled)",
                    color: "var(--p-color-text-disabled)",
                    border: "0.5px solid var(--p-color-border-disabled)",
                    padding: "9px 18px",
                    borderRadius: "9px",
                    fontSize: "13px",
                    fontWeight: 500,
                    cursor: "not-allowed",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <rect x="3" y="11" width="18" height="11" rx="2" />
                    <path d="M7 11V7a5 5 0 0110 0v4" />
                  </svg>
                  + Create plan
                </button>
              ) : (
                <Button variant="primary" onClick={handleOpenCreate}>
                  + Create plan
                </Button>
              )}
            </div>
          </InlineStack>

          {/* ── Plan usage bar ── */}
          <PlanUsageBar
            used={planGroups.length}
            limit={planLimit}
            tier={shopTier}
            planLabel={planLabel}
          />

          {/* ── Limit-reached upgrade banner ── */}
          {atLimit && (
            <div
              style={{
                background: T.redBg,
                border: `0.5px solid ${T.redBorder}`,
                borderRadius: "12px",
                padding: "14px 18px",
                display: "flex",
                gap: "12px",
                alignItems: "flex-start",
              }}
            >
              <div
                style={{
                  width: "20px",
                  height: "20px",
                  borderRadius: "50%",
                  background: "#C94040",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "11px",
                  fontWeight: 700,
                  flexShrink: 0,
                  marginTop: "1px",
                }}
              >
                !
              </div>
              <div style={{ flex: 1 }}>
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  <span style={{ color: T.redFg }}>
                    Plan limit reached ({planGroups.length}/
                    {isUnlimited ? "∞" : planLimit})
                  </span>
                </Text>
                <Text as="p" variant="bodySm">
                  <span style={{ color: "#A32D2D" }}>
                    Your <strong>{planLabel}</strong> plan allows up to{" "}
                    <strong>{planLimit}</strong> selling plan
                    {planLimit === 1 ? "" : "s"}. Upgrade to Pro or Advanced to
                    unlock more.
                  </span>
                </Text>
              </div>
              <a
                href="/app/billing"
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  color: T.redFg,
                  background: "#fff",
                  border: `0.5px solid ${T.redBorder}`,
                  borderRadius: "8px",
                  padding: "6px 14px",
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                Upgrade →
              </a>
            </div>
          )}

          {/* Error banner */}
          {actionData &&
            "ok" in actionData &&
            actionData.error &&
            !atLimit && (
              <Banner title="Error" tone="critical">
                <Text as="p">{actionData.error}</Text>
              </Banner>
            )}

          {/* ── Info banner ── */}
          <div
            style={{
              background: T.purpleBg,
              border: `0.5px solid #AFA9EC`,
              borderRadius: "12px",
              padding: "14px 18px",
              display: "flex",
              gap: "12px",
              alignItems: "flex-start",
            }}
          >
            <div
              style={{
                width: "20px",
                height: "20px",
                borderRadius: "50%",
                background: T.purpleMid,
                color: T.purpleBg,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "11px",
                fontWeight: 500,
                flexShrink: 0,
                marginTop: "1px",
              }}
            >
              i
            </div>
            <div>
              <Text as="p" variant="bodySm" fontWeight="semibold">
                <span style={{ color: T.purpleFg }}>
                  How to enable subscriptions on a product
                </span>
              </Text>
              <Text as="p" variant="bodySm">
                <span style={{ color: T.purpleMid }}>
                  After creating a plan, click "Assign product" on the card
                  below. A product picker will open — that product will
                  immediately show a "Subscribe &amp; Save" option at checkout.
                  You can also assign manually via Shopify Admin → Products →
                  Purchase options.
                </span>
              </Text>
            </div>
          </div>

          {/* ── Empty state ── */}
          {planGroups.length === 0 && (
            <div
              style={{
                background: "var(--p-color-bg-surface)",
                border: "0.5px solid var(--p-color-border)",
                borderRadius: "14px",
                padding: "56px 24px",
                textAlign: "center",
              }}
            >
              <BlockStack gap="300" inlineAlign="center">
                <div
                  style={{
                    width: "48px",
                    height: "48px",
                    borderRadius: "12px",
                    background: T.purpleBg,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    margin: "0 auto",
                  }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={T.purple} strokeWidth="2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </div>
                <Text as="p" variant="headingMd" fontWeight="bold">
                  No selling plans yet
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Create your first plan to enable subscriptions at checkout.
                </Text>
                <Button variant="primary" onClick={handleOpenCreate}>
                  Create your first plan
                </Button>
              </BlockStack>
            </div>
          )}

          {/* ── Plan cards grid ── */}
          {planGroups.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
                gap: "16px",
              }}
            >
              {planGroups.map((g) => (
                <PlanCard
                  key={g.id}
                  plan={g}
                  isSubmitting={isSubmitting}
                  onEdit={handleOpenEdit}
                  onAssign={openProductPicker}
                  onRemoveProduct={handleRemoveProduct}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </BlockStack>

        {/* ── Create / edit plan modal ── */}
        <Modal
          open={editorOpen}
          onClose={handleCloseEditor}
          title={editingPlanId ? "Edit selling plan" : "Create selling plan"}
          primaryAction={{
            content: editingPlanId ? "Save changes" : "Create plan",
            loading: isSavingPlan,
            onAction: handleCreate,
          }}
          secondaryActions={[
            { content: "Cancel", onAction: handleCloseEditor },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              {actionData && "ok" in actionData && actionData.error && (
                <Banner tone="critical">
                  <Text as="p">{actionData.error}</Text>
                </Banner>
              )}
              <TextField
                label="Plan name"
                value={name}
                onChange={setName}
                autoComplete="off"
                helpText='e.g. "Monthly Coffee Club"'
              />
              <Select
                label="Billing interval"
                options={[...INTERVAL_OPTIONS]}
                value={interval}
                onChange={setInterval}
              />
              <TextField
                label="Every how many intervals?"
                value={intervalCount}
                onChange={setIntervalCount}
                type="number"
                autoComplete="off"
                helpText='"1" = every month, "3" = every 3 months'
              />
              <TextField
                label="Discount (%)"
                value={discount}
                onChange={setDiscount}
                type="number"
                autoComplete="off"
                suffix="%"
                helpText="Set to 0 for no discount"
              />
            </BlockStack>
          </Modal.Section>
        </Modal>

        {/* ── Multi-product picker modal ── */}
        <Modal
          open={productPickerOpen}
          onClose={() => {
            setProductPickerOpen(false);
            setSelectedProductIds(new Set());
          }}
          title="Add products"
          primaryAction={{
            content:
              selectedProductIds.size > 0
                ? `Add ${selectedProductIds.size} product${selectedProductIds.size > 1 ? "s" : ""}`
                : "Add",
            disabled: selectedProductIds.size === 0 || isAssigning,
            loading: isAssigning,
            onAction: handleBulkAssign,
          }}
          secondaryActions={[
            {
              content: "Cancel",
              onAction: () => {
                setProductPickerOpen(false);
                setSelectedProductIds(new Set());
              },
            },
          ]}
        >
          <Modal.Section>
            <TextField
              label=""
              placeholder="Search products..."
              value={productSearch}
              onChange={(val) => setProductSearch(val)}
              autoComplete="off"
              clearButton
              onClearButtonClick={() => setProductSearch("")}
            />
          </Modal.Section>

          <Modal.Section>
            {filteredProducts.length === 0 ? (
              <div style={{ textAlign: "center", padding: "32px 0" }}>
                <Text as="p" variant="bodySm" tone="subdued">
                  {productSearch
                    ? "No products match your search."
                    : "No products found in your store."}
                </Text>
              </div>
            ) : (
              <BlockStack gap="200">
                {selectedProductIds.size > 0 && (
                  <div
                    style={{
                      padding: "8px 12px",
                      background: T.purpleBg,
                      border: `0.5px solid #C8C3F2`,
                      borderRadius: "8px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <Text as="span" variant="bodySm" fontWeight="semibold">
                      <span style={{ color: T.purpleFg }}>
                        {selectedProductIds.size} product
                        {selectedProductIds.size > 1 ? "s" : ""} selected
                      </span>
                    </Text>
                    <button
                      onClick={() => setSelectedProductIds(new Set())}
                      style={{
                        fontSize: "11px",
                        color: T.purpleFg,
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: "0",
                        textDecoration: "underline",
                      }}
                    >
                      Clear all
                    </button>
                  </div>
                )}

                {filteredProducts.map((product: PickerProduct) => {
                  const isSelected = selectedProductIds.has(product.id);
                  return (
                    <div
                      key={product.id}
                      onClick={() => toggleProductSelection(product.id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        padding: "10px 12px",
                        borderRadius: "10px",
                        border: `0.5px solid ${isSelected ? T.purple : "var(--p-color-border)"}`,
                        background: isSelected
                          ? T.purpleBg
                          : "var(--p-color-bg-surface)",
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                        userSelect: "none",
                      }}
                    >
                      {/* Checkbox */}
                      <div
                        style={{
                          width: "18px",
                          height: "18px",
                          borderRadius: "5px",
                          flexShrink: 0,
                          border: `2px solid ${isSelected ? T.purple : "var(--p-color-border)"}`,
                          background: isSelected ? T.purple : "transparent",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          transition: "all 0.15s ease",
                        }}
                      >
                        {isSelected && (
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                            <path
                              d="M2 6l3 3 5-5"
                              stroke="#fff"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </div>

                      {/* Thumbnail */}
                      <div
                        style={{
                          width: "36px",
                          height: "36px",
                          borderRadius: "8px",
                          background: T.tealBg,
                          overflow: "hidden",
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {product.image ? (
                          <img
                            src={product.image}
                            alt={product.title}
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          />
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.tealStroke} strokeWidth="2">
                            <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
                            <line x1="3" y1="6" x2="21" y2="6" />
                          </svg>
                        )}
                      </div>

                      {/* Title + ID */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text
                          as="p"
                          variant="bodySm"
                          fontWeight={isSelected ? "semibold" : "regular"}
                        >
                          {product.title}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {product.id.split("/").pop()}
                        </Text>
                      </div>

                      {/* Selected badge */}
                      {isSelected && (
                        <span
                          style={{
                            fontSize: "10px",
                            fontWeight: 600,
                            color: T.purpleFg,
                            background: "#fff",
                            border: `0.5px solid #C8C3F2`,
                            borderRadius: "20px",
                            padding: "2px 8px",
                            flexShrink: 0,
                          }}
                        >
                          ✓
                        </span>
                      )}
                    </div>
                  );
                })}
              </BlockStack>
            )}
          </Modal.Section>
        </Modal>

        {toastActive && (
          <Toast
            content={toastMsg}
            error={toastIsError}
            onDismiss={() => setToastActive(false)}
          />
        )}
      </Page>
    </Frame>
  );
}
