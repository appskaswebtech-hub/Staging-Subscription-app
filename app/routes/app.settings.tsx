// app/routes/app.settings.tsx
// ─────────────────────────────────────────────────────────────
// App settings — persisted per shop in AppSettings table
//
// Sections:
//   1. Notifications  — which events trigger alerts + override email
//   2. Billing        — max retries, grace period
//   3. Customer Portal — what customers can do themselves
// ─────────────────────────────────────────────────────────────

import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData, useNavigation, useSubmit } from "@remix-run/react";
import { useState, useCallback, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Checkbox,
  Select,
  Button,
  Banner,
  Divider,
  Badge,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ─── Default settings shape ───────────────────────────────────
const DEFAULTS = {
  notifyOnBillingFailure:  true,
  notifyOnCancellation:    true,
  notifyOnNewSubscription: false,
  notificationEmail:       "",
  maxBillingRetries:       3,
  gracePeriodDays:         7,
  allowCustomerPause:      true,
  allowCustomerCancel:     true,
};

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const settings = await prisma.appSettings.findUnique({
    where: { shop: session.shop },
  });

  // Return saved settings or defaults if first visit
  return json({ settings: settings ?? { ...DEFAULTS, shop: session.shop } });
}

// ─── Action ───────────────────────────────────────────────────
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form        = await request.formData();

  const data = {
    notifyOnBillingFailure:  form.get("notifyOnBillingFailure")  === "true",
    notifyOnCancellation:    form.get("notifyOnCancellation")    === "true",
    notifyOnNewSubscription: form.get("notifyOnNewSubscription") === "true",
    notificationEmail:       (form.get("notificationEmail") as string) ?? "",
    maxBillingRetries:       parseInt(form.get("maxBillingRetries") as string, 10) || 3,
    gracePeriodDays:         parseInt(form.get("gracePeriodDays")   as string, 10) || 7,
    allowCustomerPause:      form.get("allowCustomerPause")  === "true",
    allowCustomerCancel:     form.get("allowCustomerCancel") === "true",
  };

  // Validate
  if (data.maxBillingRetries < 1 || data.maxBillingRetries > 10) {
    return json({ error: "Max billing retries must be between 1 and 10." });
  }
  if (data.gracePeriodDays < 1 || data.gracePeriodDays > 90) {
    return json({ error: "Grace period must be between 1 and 90 days." });
  }
  if (data.notificationEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.notificationEmail)) {
    return json({ error: "Please enter a valid notification email address." });
  }

  await prisma.appSettings.upsert({
    where:  { shop: session.shop },
    update: data,
    create: { shop: session.shop, ...data },
  });

  return json({ success: true });
}

// ─── Component ────────────────────────────────────────────────
export default function Settings() {
  const { settings }  = useLoaderData<typeof loader>();
  const actionData    = useActionData<typeof action>();
  const navigation    = useNavigation();
  const submit        = useSubmit();
  const isSaving      = navigation.state === "submitting";

  // ── Local form state ───────────────────────────────────────
  const [notifyBilling,  setNotifyBilling]  = useState(settings.notifyOnBillingFailure);
  const [notifyCancel,   setNotifyCancel]   = useState(settings.notifyOnCancellation);
  const [notifyNew,      setNotifyNew]      = useState(settings.notifyOnNewSubscription);
  const [notifyEmail,    setNotifyEmail]    = useState(settings.notificationEmail ?? "");
  const [maxRetries,     setMaxRetries]     = useState(String(settings.maxBillingRetries));
  const [gracePeriod,    setGracePeriod]    = useState(String(settings.gracePeriodDays));
  const [allowPause,     setAllowPause]     = useState(settings.allowCustomerPause);
  const [allowCancel,    setAllowCancel]    = useState(settings.allowCustomerCancel);

  // Show saved banner then auto-hide after 3 s
  const [showSaved, setShowSaved] = useState(false);
  useEffect(() => {
    if (actionData && "success" in actionData) {
      setShowSaved(true);
      const t = setTimeout(() => setShowSaved(false), 3000);
      return () => clearTimeout(t);
    }
  }, [actionData]);

  // ── Submit ─────────────────────────────────────────────────
  const handleSave = useCallback(() => {
    const fd = new FormData();
    fd.append("notifyOnBillingFailure",  String(notifyBilling));
    fd.append("notifyOnCancellation",    String(notifyCancel));
    fd.append("notifyOnNewSubscription", String(notifyNew));
    fd.append("notificationEmail",       notifyEmail);
    fd.append("maxBillingRetries",       maxRetries);
    fd.append("gracePeriodDays",         gracePeriod);
    fd.append("allowCustomerPause",      String(allowPause));
    fd.append("allowCustomerCancel",     String(allowCancel));
    submit(fd, { method: "post" });
  }, [
    notifyBilling, notifyCancel, notifyNew, notifyEmail,
    maxRetries, gracePeriod, allowPause, allowCancel, submit,
  ]);

  const retryOptions = Array.from({ length: 10 }, (_, i) => ({
    label: `${i + 1} attempt${i > 0 ? "s" : ""}`,
    value: String(i + 1),
  }));

  const graceOptions = [1, 2, 3, 5, 7, 14, 21, 30, 60, 90].map((d) => ({
    label: `${d} day${d > 1 ? "s" : ""}`,
    value: String(d),
  }));

  return (
    <Page
      title="Settings"
      subtitle="Configure your subscription app behaviour"
      backAction={{ content: "Dashboard", url: "/app" }}
      primaryAction={{
        content: "Save Settings",
        loading: isSaving,
        onAction: handleSave,
      }}
    >
      <TitleBar title="Settings" />

      <BlockStack gap="500">

        {/* ── Feedback banners ──────────────────────────────── */}
        {showSaved && (
          <Banner tone="success" title="Settings saved successfully." onDismiss={() => setShowSaved(false)} />
        )}
        {actionData && "error" in actionData && (
          <Banner tone="critical" title="Could not save settings">
            <Text as="p">{actionData.error}</Text>
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <BlockStack gap="500">

              {/* ── 1. Notifications ──────────────────────────── */}
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">Notifications</Text>
                    <Text as="p" tone="subdued" variant="bodySm">
                      Choose which events send an alert email to you or your team.
                    </Text>
                  </BlockStack>
                  <Divider />

                  <BlockStack gap="300">
                    <Checkbox
                      label="Billing failure"
                      helpText="Get notified when a customer's payment fails."
                      checked={notifyBilling}
                      onChange={setNotifyBilling}
                    />
                    <Checkbox
                      label="Subscription cancelled"
                      helpText="Get notified when a subscription is cancelled."
                      checked={notifyCancel}
                      onChange={setNotifyCancel}
                    />
                    <Checkbox
                      label="New subscription"
                      helpText="Get notified when a customer starts a new subscription."
                      checked={notifyNew}
                      onChange={setNotifyNew}
                    />
                  </BlockStack>

                  <Divider />

                  <TextField
                    label="Notification email"
                    helpText="Leave blank to use your Shopify store owner email."
                    type="email"
                    value={notifyEmail}
                    onChange={setNotifyEmail}
                    placeholder="alerts@yourstore.com"
                    autoComplete="email"
                    disabled={!notifyBilling && !notifyCancel && !notifyNew}
                  />
                </BlockStack>
              </Card>

              {/* ── 2. Billing ────────────────────────────────── */}
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">Billing Behaviour</Text>
                    <Text as="p" tone="subdued" variant="bodySm">
                      Control how the app handles failed payments before cancelling a subscription.
                    </Text>
                  </BlockStack>
                  <Divider />

                  <Select
                    label="Max billing retry attempts"
                    helpText="How many times to retry a failed charge before marking the subscription as failed."
                    options={retryOptions}
                    value={maxRetries}
                    onChange={setMaxRetries}
                  />

                  <Select
                    label="Grace period after final failure"
                    helpText="Days to wait after the last failed retry before automatically cancelling the subscription."
                    options={graceOptions}
                    value={gracePeriod}
                    onChange={setGracePeriod}
                  />

                  {/* Visual summary */}
                  <Box
                    background="bg-surface-secondary"
                    padding="300"
                    borderRadius="200"
                  >
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span" variant="bodySm" tone="subdued">Summary:</Text>
                      <Text as="span" variant="bodySm">
                        Retry up to{" "}
                        <strong>{maxRetries} time{Number(maxRetries) > 1 ? "s" : ""}</strong>
                        , then wait{" "}
                        <strong>{gracePeriod} day{Number(gracePeriod) > 1 ? "s" : ""}</strong>
                        {" "}before cancelling.
                      </Text>
                    </InlineStack>
                  </Box>
                </BlockStack>
              </Card>

              {/* ── 3. Customer Portal ────────────────────────── */}
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">Customer Portal</Text>
                    <Text as="p" tone="subdued" variant="bodySm">
                      Control what customers can do from their own account portal.
                    </Text>
                  </BlockStack>
                  <Divider />

                  <BlockStack gap="300">
                    <Checkbox
                      label="Allow customers to pause their subscription"
                      helpText="Customers can temporarily pause billing from their account page."
                      checked={allowPause}
                      onChange={setAllowPause}
                    />
                    <Checkbox
                      label="Allow customers to cancel their subscription"
                      helpText="Customers can cancel at any time from their account page."
                      checked={allowCancel}
                      onChange={setAllowCancel}
                    />
                  </BlockStack>

                  {!allowPause && !allowCancel && (
                    <Banner tone="warning">
                      <Text as="p">
                        Customers can't manage their own subscriptions. Only you can pause or cancel from the admin.
                      </Text>
                    </Banner>
                  )}
                </BlockStack>
              </Card>

            </BlockStack>
          </Layout.Section>

          {/* ── Right sidebar — status summary ────────────────── */}
          <Layout.Section variant="oneThird">
            <BlockStack gap="400">

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Current Configuration</Text>
                  <Divider />

                  <BlockStack gap="200">
                    <InlineStack align="space-between">
                      <Text as="span" tone="subdued" variant="bodySm">Billing failure alert</Text>
                      <Badge tone={notifyBilling ? "success" : "enabled"}>
                        {notifyBilling ? "On" : "Off"}
                      </Badge>
                    </InlineStack>

                    <InlineStack align="space-between">
                      <Text as="span" tone="subdued" variant="bodySm">Cancellation alert</Text>
                      <Badge tone={notifyCancel ? "success" : "enabled"}>
                        {notifyCancel ? "On" : "Off"}
                      </Badge>
                    </InlineStack>

                    <InlineStack align="space-between">
                      <Text as="span" tone="subdued" variant="bodySm">New subscription alert</Text>
                      <Badge tone={notifyNew ? "success" : "enabled"}>
                        {notifyNew ? "On" : "Off"}
                      </Badge>
                    </InlineStack>

                    <Divider />

                    <InlineStack align="space-between">
                      <Text as="span" tone="subdued" variant="bodySm">Max retries</Text>
                      <Text as="span" variant="bodySm" fontWeight="semibold">{maxRetries}×</Text>
                    </InlineStack>

                    <InlineStack align="space-between">
                      <Text as="span" tone="subdued" variant="bodySm">Grace period</Text>
                      <Text as="span" variant="bodySm" fontWeight="semibold">{gracePeriod}d</Text>
                    </InlineStack>

                    <Divider />

                    <InlineStack align="space-between">
                      <Text as="span" tone="subdued" variant="bodySm">Customer can pause</Text>
                      <Badge tone={allowPause ? "success" : "enabled"}>
                        {allowPause ? "Yes" : "No"}
                      </Badge>
                    </InlineStack>

                    <InlineStack align="space-between">
                      <Text as="span" tone="subdued" variant="bodySm">Customer can cancel</Text>
                      <Badge tone={allowCancel ? "success" : "enabled"}>
                        {allowCancel ? "Yes" : "No"}
                      </Badge>
                    </InlineStack>
                  </BlockStack>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Registered Webhooks</Text>
                  <Divider />
                  <BlockStack gap="150">
                    {[
                      "SUBSCRIPTION_CONTRACTS_CREATE",
                      "SUBSCRIPTION_CONTRACTS_UPDATE",
                      "SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS",
                      "SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE",
                      "APP_UNINSTALLED",
                    ].map((topic) => (
                      <InlineStack key={topic} align="space-between" blockAlign="center">
                        <Text as="span" variant="bodySm" tone="subdued">
                          {topic.split("_").map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ")}
                        </Text>
                        <Badge tone="success">Active</Badge>
                      </InlineStack>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>

            </BlockStack>
          </Layout.Section>
        </Layout>

        {/* ── Bottom save button (convenience) ──────────────── */}
        <InlineStack align="end">
          <Button variant="primary" loading={isSaving} onClick={handleSave}>
            Save Settings
          </Button>
        </InlineStack>

      </BlockStack>
    </Page>
  );
}
