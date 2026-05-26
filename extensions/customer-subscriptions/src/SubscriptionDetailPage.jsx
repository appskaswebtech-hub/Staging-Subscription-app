// extensions/customer-subscriptions/src/SubscriptionDetailPage.jsx
// Customer Account UI Extension — Single subscription detail:
//   • Full subscription info (status, plan, product, next billing)
//   • Recurring payment / billing attempt history (via app proxy)
//   • Pause / Resume / Cancel actions

import "@shopify/ui-extensions/preact";
import { render, useState, useEffect } from "preact/compat";

const STORAGE_KEY = "sub_locale";

// ─── GraphQL — fetch one subscription by ID from URL ─────────────
// Customer Account API passes the page path; we read the contract ID
// from `shopify.customerAccount.pageUrl` or route params.
const SUBSCRIPTION_QUERY = `
  {
    customer {
      id
      subscriptionContracts(first: 50) {
        edges {
          node {
            id
            status
            nextBillingDate
            createdAt
            lines(first: 5) {
              edges {
                node {
                  id
                  title
                  name
                  quantity
                  image { url altText }
                  currentPrice { amount currencyCode }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const GQL_ENDPOINT = "shopify://customer-account/api/2026-04/graphql.json";

function tr(key) {
  if (typeof window === "undefined") return null;
  return (window.__sub_translations && window.__sub_translations[key]) || null;
}

function t(key, fallback) {
  var value = tr(key);
  return value === null || value === undefined || value === "" ? fallback : value;
}

// ─── Helpers ──────────────────────────────────────────────────────
function norm(s) {
  return s ? s.toString().toUpperCase().trim() : "UNKNOWN";
}

function fmtDate(d) {
  if (!d) return "—";
  var locale = typeof window !== "undefined" ? window.__sub_locale || undefined : undefined;
  return new Date(d).toLocaleDateString(locale, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function fmtDateTime(d) {
  if (!d) return "—";
  var locale = typeof window !== "undefined" ? window.__sub_locale || undefined : undefined;
  return new Date(d).toLocaleString(locale, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function statusTone(s) {
  var st = norm(s);
  if (st === "ACTIVE")    return "success";
  if (st === "PAUSED")    return "warning";
  if (st === "FAILED")    return "critical";
  if (st === "CANCELLED") return "critical";
  if (st === "EXPIRED")   return "info";
  return "info";
}

function statusLabel(s) {
  var st = norm(s);
  var map = {
    ACTIVE: t("status_active", "Active"),
    PAUSED: t("status_paused", "Paused"),
    CANCELLED: t("status_cancelled", "Cancelled"),
    FAILED: t("status_failed", "Failed"),
    EXPIRED: t("status_expired", "Expired"),
  };
  return map[st] || (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : "");
}

function attemptTone(s) {
  var st = norm(s);
  if (st === "SUCCESS")  return "success";
  if (st === "FAILED")   return "critical";
  if (st === "PENDING")  return "warning";
  return "info";
}

async function getShopHost() {
  try {
    if (shopify && shopify.shop && shopify.shop.myshopifyDomain) {
      return shopify.shop.myshopifyDomain;
    }
  } catch (e) {}

  try {
    var token = await shopify.sessionToken.get();
    var payload = JSON.parse(atob(token.split(".")[1]));
    return new URL(payload.dest).hostname;
  } catch (e) {
    console.error("getShopHost error:", e);
    return null;
  }
}

async function loadTranslations(shopHost) {
  if (!shopHost) return false;

  try {
    var res = await fetch("https://" + shopHost + "/apps/subscriptions/translations");
    if (!res.ok) throw new Error("locale not found");

    var data = await res.json();
    if (typeof window !== "undefined") {
      window.__sub_translations = data.translation || {};
      window.__sub_locale = data.effectiveLocale || data.preferredLocale || "en";
      localStorage.setItem(STORAGE_KEY, window.__sub_locale);
    }
    return true;
  } catch (e) {
    if (typeof window !== "undefined") {
      window.__sub_translations = {};
      window.__sub_locale = localStorage.getItem(STORAGE_KEY) || "en";
    }
    return false;
  }
}

// ─── Get contract ID from current URL ────────────────────────────
// Shopify Customer Account pages receive their URL via
// `shopify.customerAccount.pageUrl` or via URL hash/query.
// We expect the route to be: /pages/subscriptions/:contractId
function getContractIdFromUrl() {
  try {
    var params = new URLSearchParams(window.location.search);
    var fromQuery = params.get("contractId");
    if (fromQuery) return fromQuery;

    // fallback: last path segment
    var match = window.location.href.match(/\/subscriptions\/([^?#/]+)/);
    if (match) return decodeURIComponent(match[1]);

    return null;
  } catch (e) {
    return null;
  }
}

// ─── BillingAttemptRow ────────────────────────────────────────────
function BillingAttemptRow({ attempt }) {
  return (
    <s-box padding-block="base" padding-inline="none">
      <s-grid gridTemplateColumns="1fr auto" alignItems="center" gap="base">
        {/* Left: date + error */}
        <s-stack gap="extraTight">
          <s-text type="strong">{fmtDateTime(attempt.createdAt)}</s-text>
          {attempt.errorMessage
            ? <s-paragraph>{attempt.errorMessage}</s-paragraph>
            : null
          }
        </s-stack>

        {/* Right: amount + status badge */}
        <s-stack direction="inline" gap="tight" block-align="center">
          <s-text type="strong">
            {attempt.currency} {attempt.amount.toFixed(2)}
          </s-text>
          <s-badge tone={attemptTone(attempt.status)}>
            {statusLabel(attempt.status)}
          </s-badge>
        </s-stack>
      </s-grid>
    </s-box>
  );
}

// ─── Main Detail Page ─────────────────────────────────────────────
function SubscriptionDetailPage() {
  var stateArr    = useState("loading");    // loading | done | error | notfound
  var subArr      = useState(null);
  var attemptsArr = useState([]);
  var msgArr      = useState("");
  var loadingActArr = useState(null);
  var actionMsgArr  = useState("");
  var localeReadyArr = useState(false);

  var getState      = stateArr[0];      var setState      = stateArr[1];
  var getSub        = subArr[0];        var setSub        = subArr[1];
  var getAttempts   = attemptsArr[0];   var setAttempts   = attemptsArr[1];
  var getMsg        = msgArr[0];        var setMsg        = msgArr[1];
  var getLoadingAct = loadingActArr[0]; var setLoadingAct = loadingActArr[1];
  var getActionMsg  = actionMsgArr[0];  var setActionMsg  = actionMsgArr[1];
  var localeReady   = localeReadyArr[0]; var setLocaleReady = localeReadyArr[1];

  useEffect(function() {
    getShopHost()
      .then(function(shopHost) {
        if (!shopHost) return false;
        return loadTranslations(shopHost);
      })
      .finally(function() {
        setLocaleReady(true);
      });
  }, [setLocaleReady]);

  // ── Load subscription data ──────────────────────────────────────
  useEffect(function () {
    var contractId = getContractIdFromUrl();

    // Fetch all contracts, then filter to the one we want
    fetch(GQL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: SUBSCRIPTION_QUERY }),
    })
      .then(function (res) { return res.json(); })
      .then(function (json) {
        if (json.errors && json.errors.length) {
          setMsg(json.errors[0].message);
          setState("error");
          return;
        }

        var customer = json.data && json.data.customer;
        if (!customer) { setState("notfound"); return; }

        var edges = (customer.subscriptionContracts && customer.subscriptionContracts.edges) || [];

        // Find the matching contract (compare short ID or full GID)
        var found = edges.find(function (e) {
          var node = e.node;
          var shortId = node.id.split("/").pop();
          return (
            shortId === contractId ||
            node.id === contractId ||
            node.id === ("gid://shopify/SubscriptionContract/" + contractId)
          );
        });

        if (!found) {
          // If no contractId in URL, default to first subscription
          if (!contractId && edges.length > 0) {
            found = edges[0];
          } else {
            setState("notfound");
            return;
          }
        }

        var node = found.node;
        var lineEdges = node.lines.edges;
        var total = 0;
        var currency = "USD";

        var lines = lineEdges.map(function (le) {
          var l = le.node;
          var price = parseFloat(l.currentPrice.amount);
          currency = l.currentPrice.currencyCode;
          total += price * (l.quantity || 1);
          return {
            id:       l.id,
            title:    l.name || l.title,
            qty:      l.quantity || 1,
            price:    price,
            currency: l.currentPrice.currencyCode,
            imgUrl:   l.image ? l.image.url : null,
            imgAlt:   l.image ? (l.image.altText || l.title) : l.title,
          };
        });

        var shaped = {
          id:         node.id.split("/").pop(),
          gid:        node.id,
          status:     norm(node.status),
          next:       node.nextBillingDate,
          createdAt:  node.createdAt,
          total:      total,
          currency:   currency,
          customerId: customer.id,
          lines:      lines,
        };

        setSub(shaped);

        // ── Fetch billing attempts from our app proxy ──────────────
        return getShopHost()
          .then(function(shopHost) {
            if (!shopHost) throw new Error("missing shop");

            return fetch(
              "https://" + shopHost + "/apps/subscriptions/billing-history?contractId=" + shaped.id,
              { headers: { "Content-Type": "application/json" } }
            );
          })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.attempts) {
              setAttempts(data.attempts);
            }
            setState("done");
          })
          .catch(function () {
            // Non-fatal — show subscription even without billing history
            setState("done");
          });
      })
      .catch(function (err) {
        setMsg(err && err.message ? err.message : "fetch failed");
        setState("error");
      });
  }, [setAttempts, setMsg, setState, setSub]);

  // ── Action handler (pause / resume / cancel) ───────────────────
  async function doAction(intent) {
    if (!getSub) return;
    setLoadingAct(intent);
    setActionMsg("");

    var shop = await getShopHost();
    if (!shop) {
      setLoadingAct(null);
      setActionMsg(t("error_could_not_get_app_info", "Error: Could not get app info."));
      return;
    }

    fetch("https://" + shop + "/apps/subscriptions/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractId: getSub.gid,
        customerId: getSub.customerId,
        intent: intent,
        shop: shop,
      }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        setLoadingAct(null);
        if (data.error) {
          setActionMsg(t("error_prefix", "Error: ") + data.error);
          return;
        }
        var labels = {
          pause: t("paused_success", "Paused successfully."),
          resume: t("resumed", "Resumed."),
          cancel: t("cancelled", "Cancelled."),
        };
        setActionMsg(labels[intent] || t("done", "Done."));
        setSub(function (prev) {
          return Object.assign({}, prev, { status: norm(data.status) });
        });
      })
      .catch(function (err) {
        setLoadingAct(null);
        setActionMsg(t("failed_prefix", "Failed: ") + (err && err.message ? err.message : "unknown error"));
      });
  }

  // ── Loading ────────────────────────────────────────────────────
  if (!localeReady || getState === "loading") {
    return (
      <s-page heading={t("subscription_details", "Subscription Details")}>
        <s-section>
          <s-stack block-align="center" direction="inline" gap="base">
            <s-spinner />
            <s-paragraph>{t("loading_subscription", "Loading subscription…")}</s-paragraph>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  // ── Error ──────────────────────────────────────────────────────
  if (getState === "error") {
    return (
      <s-page heading={t("subscription_details", "Subscription Details")}>
        <s-section>
          <s-banner tone="critical">
            <s-paragraph>{getMsg || t("something_went_wrong", "Something went wrong.")}</s-paragraph>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  // ── Not Found ──────────────────────────────────────────────────
  if (getState === "notfound" || !getSub) {
    return (
      <s-page heading={t("subscription_details", "Subscription Details")}>
        <s-section>
          <s-banner tone="warning">
            <s-paragraph>{t("subscription_not_found", "Subscription not found.")}</s-paragraph>
          </s-banner>
          <s-box padding-block-start="base">
            <s-button variant="secondary" to="/pages/subscriptions">
              {"← " + t("back_to_subscriptions", "Back to Subscriptions")}
            </s-button>
          </s-box>
        </s-section>
      </s-page>
    );
  }

  var sub = getSub;
  var status = sub.status;
  var isCancelled = status === "CANCELLED" || status === "EXPIRED";

  // ─── Render ──────────────────────────────────────────────────
  return (
    <s-page heading={t("subscription_details", "Subscription Details")}>

      {/* ── Back link ────────────────────────────────────────── */}
      <s-box padding-block-end="base">
        <s-button
          variant="plain"
          onClick={function() {
            shopify.customerAccount.navigate(
              "/account/extensions/customer-subscriptions-dashboard"
            );
          }}
        >
          {"← " + t("all_subscriptions", "All Subscriptions")}
        </s-button>
      </s-box>

      {/* ── 1. Overview Card ─────────────────────────────────── */}
      <s-section heading={t("overview", "Overview")}>
        <s-box padding="base">
          <s-stack gap="base">

            {/* Status row */}
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-stack gap="extraTight">
                <s-text subdued>{t("status_label", "Status")}</s-text>
                <s-badge tone={statusTone(status)}>
                  {statusLabel(status)}
                </s-badge>
              </s-stack>

              <s-stack gap="extraTight">
                <s-text subdued>{t("subscription_id_label", "Subscription ID")}</s-text>
                <s-text type="strong">#{sub.id}</s-text>
              </s-stack>
            </s-grid>

            <s-divider />

            {/* Dates row */}
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-stack gap="extraTight">
                <s-text subdued>{t("started_label", "Started")}</s-text>
                <s-text>{fmtDate(sub.createdAt)}</s-text>
              </s-stack>

              <s-stack gap="extraTight">
                <s-text subdued>{t("next_billing_detail_label", "Next Billing")}</s-text>
                <s-text type="strong">
                  {status === "ACTIVE" ? fmtDate(sub.next) : "—"}
                </s-text>
              </s-stack>
            </s-grid>

          </s-stack>
        </s-box>
      </s-section>

      {/* ── 2. Items in this subscription ────────────────────── */}
      <s-section heading={t("items", "Items")}>
        <s-box padding="base">
          <s-stack gap="base">
            {sub.lines.map(function (line) {
              return (
                <s-box key={line.id} padding-block-end="base">
                  <s-grid gridTemplateColumns="72px 1fr" gap="base" alignItems="center">
                    {/* Product image */}
                    {line.imgUrl
                      ? (
                        <s-image
                          src={line.imgUrl}
                          alt={line.imgAlt}
                          aspectRatio="1/1"
                          objectFit="cover"
                          borderRadius="base"
                          inlineSize="fill"
                        />
                      )
                      : <s-box padding="large" border-radius="base" background="surface-secondary" />
                    }

                    {/* Product info */}
                    <s-stack gap="extraTight">
                      <s-text type="strong">{line.title}</s-text>
                      <s-paragraph>{t("qty_label", "Qty") + ": " + line.qty}</s-paragraph>
                      <s-paragraph>
                        {line.currency} {(line.price * line.qty).toFixed(2)} {t("per_charge_suffix", "/ charge")}
                      </s-paragraph>
                    </s-stack>
                  </s-grid>
                </s-box>
              );
            })}

            <s-divider />

            {/* Total */}
            <s-grid gridTemplateColumns="1fr auto" alignItems="center">
              <s-text type="strong">{t("total_per_billing_cycle", "Total per billing cycle")}</s-text>
              <s-text type="strong">
                {sub.currency} {sub.total.toFixed(2)}
              </s-text>
            </s-grid>
          </s-stack>
        </s-box>
      </s-section>

      {/* ── 3. Billing History ───────────────────────────────── */}
      <s-section heading={t("payment_history", "Payment History")}>
        <s-box padding="base">
          {getAttempts.length === 0
            ? (
              <s-banner tone="info">
                <s-paragraph>{t("no_payment_attempts", "No payment attempts recorded yet.")}</s-paragraph>
              </s-banner>
            )
            : (
              <s-stack gap="none">
                {getAttempts.map(function (attempt, idx) {
                  return (
                    <s-box key={attempt.id || idx}>
                      <BillingAttemptRow attempt={attempt} />
                      {idx < getAttempts.length - 1 ? <s-divider /> : null}
                    </s-box>
                  );
                })}
              </s-stack>
            )
          }
        </s-box>
      </s-section>

      {/* ── 4. Actions ───────────────────────────────────────── */}
      {!isCancelled
        ? (
          <s-section heading={t("manage_subscription", "Manage Subscription")}>
            <s-box padding="base">
              <s-stack gap="base">

                {/* Feedback banner */}
                {getActionMsg
                  ? (
                    <s-banner
                      tone={getActionMsg.startsWith("Error") || getActionMsg.startsWith("Failed") ? "critical" : "success"}
                    >
                      <s-paragraph>{getActionMsg}</s-paragraph>
                    </s-banner>
                  ) : null
                }

                {/* Info for paused */}
                {status === "PAUSED"
                  ? (
                    <s-banner tone="warning">
                      <s-paragraph>
                        {t("paused_notice", "Your subscription is paused. No charges will be made until you resume it.")}
                      </s-paragraph>
                    </s-banner>
                  ) : null
                }

                <s-button-group>
                  {/* Pause — only when ACTIVE */}
                  {status === "ACTIVE"
                    ? (
                      <s-button
                        variant="secondary"
                        tone="default"
                        loading={getLoadingAct === "pause"}
                        disabled={getLoadingAct !== null}
                        onClick={function () { doAction("pause"); }}
                      >
                        {t("pause_subscription", "Pause Subscription")}
                      </s-button>
                    ) : null
                  }

                  {/* Resume — when PAUSED or FAILED */}
                  {(status === "PAUSED" || status === "FAILED")
                    ? (
                      <s-button
                        variant="primary"
                        tone="success"
                        loading={getLoadingAct === "resume"}
                        disabled={getLoadingAct !== null}
                        onClick={function () { doAction("resume"); }}
                      >
                        {t("resume_subscription", "Resume Subscription")}
                      </s-button>
                    ) : null
                  }

                  {/* Cancel — always visible when not already cancelled */}
                  <s-button
                    variant="secondary"
                    tone="critical"
                    loading={getLoadingAct === "cancel"}
                    disabled={getLoadingAct !== null}
                    onClick={function () { doAction("cancel"); }}
                  >
                    Cancel Subscription
                  </s-button>
                </s-button-group>

                {/* Cancel warning disclaimer */}
                <s-text subdued>
                  {t("cancel_disclaimer", "Cancelling your subscription will stop all future charges. This action cannot be undone.")}
                </s-text>

              </s-stack>
            </s-box>
          </s-section>
        ) : (
          <s-section heading={t("subscription_status_heading", "Subscription Status")}>
            <s-box padding="base">
              <s-banner tone="info">
                <s-paragraph>
                  {t("subscription_has_been", "This subscription has been")} {statusLabel(status).toLowerCase()}. {t("no_further_charges", "No further charges will be made.")}
                </s-paragraph>
              </s-banner>
            </s-box>
          </s-section>
        )
      }

    </s-page>
  );
}

// ─── Entry Point ──────────────────────────────────────────────────
export default function () {
  render(<SubscriptionDetailPage />, document.body);
}
