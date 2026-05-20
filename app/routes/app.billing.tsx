// app/routes/app.billing.tsx

import { redirect }                                    from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useLoaderData,
  useActionData,
  useNavigate,
  useNavigation,
  Form,
} from "@remix-run/react";
import { useState, useEffect } from "react";
import {
  Page,
  BlockStack,
  InlineStack,
  InlineGrid,
  Box,
  Text,
  Button,
  Badge,
  Banner,
  List,
} from "@shopify/polaris";
import { TitleBar }             from "@shopify/app-bridge-react";
import { authenticate }         from "../shopify.server";
import { PLANS, PLAN_KEYS }     from "../config/plans";
import { getShopPlanFromDB }    from "../utils/planUtils";

// ─── Types ────────────────────────────────────────────────────
interface LoaderData {
  currentPlan: string;
}

interface ActionData {
  confirmationUrl?: string;
  error?:          string;
}

interface UserError {
  field:   string;
  message: string;
}

interface AppSubscriptionCreateResponse {
  data?: {
    appSubscriptionCreate?: {
      confirmationUrl?: string;
      userErrors?:      UserError[];
      appSubscription?: { id: string };
    };
  };
}

// ─── Plan display order (safe — filter out any undefined) ──────
const PLANS_ORDERED = ["basic", "pro", "advanced"]
  .map((key) => PLANS[key])
  .filter(Boolean);

// ─── LOADER ───────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const record      = await getShopPlanFromDB(session.shop);
  return { currentPlan: record.plan } satisfies LoaderData;
};

// ─── ACTION ───────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop     = session.shop;
  const formData = await request.formData();
  const planKey  = formData.get("plan") as string;

  if (!PLAN_KEYS.includes(planKey)) {
    return { error: `Invalid plan: "${planKey}"` } satisfies ActionData;
  }

  const selectedPlan = PLANS[planKey];

  try {
    const response = await admin.graphql(
      `#graphql
      mutation AppSubscriptionCreate(
        $name:      String!
        $lineItems: [AppSubscriptionLineItemInput!]!
        $returnUrl: URL!
        $trialDays: Int
        $test:      Boolean
      ) {
        appSubscriptionCreate(
          name:      $name
          returnUrl: $returnUrl
          lineItems: $lineItems
          trialDays: $trialDays
          test:      $test
        ) {
          userErrors { field message }
          appSubscription { id }
          confirmationUrl
        }
      }`,
      {
        variables: {
          name:      planKey,
          returnUrl: `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}/app/billing-return`,
          trialDays: selectedPlan.trialDays,
          test:      true, // ← set false in production
          lineItems: [
            {
              plan: {
                appRecurringPricingDetails: {
                  price:    { amount: selectedPlan.price, currencyCode: "USD" },
                  interval: "EVERY_30_DAYS",
                },
              },
            },
          ],
        },
      }
    );

    const resJson: AppSubscriptionCreateResponse = await response.json();
    const { confirmationUrl, userErrors } =
      resJson.data?.appSubscriptionCreate ?? {};

    if (userErrors?.length) {
      return {
        error: userErrors.map((e) => e.message).join(", "),
      } satisfies ActionData;
    }

    if (!confirmationUrl) {
      return {
        error: "No confirmation URL returned from Shopify.",
      } satisfies ActionData;
    }

    return { confirmationUrl } satisfies ActionData;

  } catch (err) {
    console.error("[app.billing] action error:", err);
    return {
      error: "Something went wrong. Please try again.",
    } satisfies ActionData;
  }
};

// ─── COMPONENT ────────────────────────────────────────────────
export default function BillingPage() {
  const { currentPlan } = useLoaderData<typeof loader>();
  const actionData      = useActionData<typeof action>();
  const navigate        = useNavigate();
  const navigation      = useNavigation();
  const [submittingPlan, setSubmittingPlan] = useState<string | null>(null);

  const isSubmitting = navigation.state === "submitting";

  // Safe — handles "free" or any unknown legacy DB value
  const currentPlanMeta  = PLANS[currentPlan];
  const currentPlanLabel = currentPlanMeta?.label ?? currentPlan.toUpperCase();
  const currentPlanPrice = currentPlanMeta?.price ?? 0;

  // Redirect merchant out of Shopify iframe to confirm billing
  useEffect(() => {
    if (actionData?.confirmationUrl) {
      open(actionData.confirmationUrl, "_top");
    }
  }, [actionData]);

  return (
    <Page
      title="Choose Your Plan"
      subtitle="Select the plan that best fits your store's needs"
      backAction={{ content: "Back", onAction: () => navigate("/app") }}
    >
      <TitleBar title="Billing" />

      <BlockStack gap="500">

        {/* Error banner */}
        {actionData?.error && (
          <Banner title="Billing Error" tone="critical">
            <Text as="p">{actionData.error}</Text>
          </Banner>
        )}

        {/* Redirect banner */}
        {actionData?.confirmationUrl && (
          <Banner title="Redirecting to Shopify billing…" tone="info">
            <Text as="p">
              Please wait while we redirect you to confirm your subscription.
            </Text>
          </Banner>
        )}

        {/* Current plan banner */}
        <Banner
          title={`You are currently on the ${currentPlanLabel} plan`}
          tone="info"
        >
          <Text as="p">
            {currentPlan === "advanced"
              ? "You have access to all features. Manage your plan below."
              : "Upgrade anytime to unlock more features for your store."}
          </Text>
        </Banner>

        {/* Pricing cards */}
        <InlineGrid columns={{ xs: 1, sm: 1, md: 3 }} gap="400">
          {PLANS_ORDERED.map((plan) => {
            const isCurrent = currentPlan === plan.key;

            return (
              <div
                key={plan.key}
                style={{
                  borderRadius:  "12px",
                  border:        isCurrent
                    ? "2px solid #008060"
                    : plan.popular
                    ? "2px solid #005bd3"
                    : "1px solid #e1e3e5",
                  background:    "#ffffff",
                  boxShadow:     plan.popular
                    ? "0 4px 20px rgba(0,91,211,0.12)"
                    : "0 1px 4px rgba(0,0,0,0.06)",
                  display:       "flex",
                  flexDirection: "column",
                  overflow:      "hidden",
                  position:      "relative",
                }}
              >
                {/* Card Header */}
                <div
                  style={{
                    background:   plan.color,
                    padding:      "20px 24px 16px",
                    borderBottom: "1px solid #e1e3e5",
                  }}
                >
                  <InlineStack align="space-between" blockAlign="center">
                    <Text variant="headingLg" fontWeight="bold" as="h2">
                      {plan.label}
                    </Text>
                    <InlineStack gap="200">
                      {plan.popular && <Badge tone="info">Most Popular</Badge>}
                      {isCurrent   && <Badge tone="success">Current</Badge>}
                    </InlineStack>
                  </InlineStack>

                  <Box paddingBlockStart="200">
                    <Text variant="heading2xl" fontWeight="bold" as="p">
                      ${plan.price}
                    </Text>
                    <Text variant="bodySm" tone="subdued" as="p">
                      per month · {plan.trialDays}-day free trial
                    </Text>
                  </Box>
                </div>

                {/* Features */}
                <div style={{ padding: "20px 24px", flexGrow: 1 }}>
                  <BlockStack gap="200">
                    <Text variant="bodyMd" fontWeight="semibold" as="p">
                      What's included:
                    </Text>
                    <List type="bullet">
                      {plan.features.map((f, i) => (
                        <List.Item key={i}>{f}</List.Item>
                      ))}
                    </List>
                  </BlockStack>
                </div>

                {/* CTA */}
                <div
                  style={{ padding: "16px 24px", borderTop: "1px solid #e1e3e5" }}
                >
                  {isCurrent ? (
                    <Button fullWidth disabled>✓ Current Plan</Button>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="plan" value={plan.key} />
                      <Button
                        fullWidth
                        variant="primary"
                        submit
                        loading={
                          (isSubmitting && submittingPlan === plan.key) ||
                          !!actionData?.confirmationUrl
                        }
                        onClick={() => setSubmittingPlan(plan.key)}
                      >
                        {currentPlanPrice > plan.price
                          ? `Downgrade to ${plan.label}`
                          : `Upgrade to ${plan.label}`}
                      </Button>
                    </Form>
                  )}
                </div>

              </div>
            );
          })}
        </InlineGrid>

        {/* Footer */}
        <Box paddingBlockEnd="400">
          <Text alignment="center" tone="subdued" variant="bodySm" as="p">
            All plans include a 7-day free trial. Cancel anytime from your Shopify admin. Billed in USD.
          </Text>
        </Box>

      </BlockStack>
    </Page>
  );
}
