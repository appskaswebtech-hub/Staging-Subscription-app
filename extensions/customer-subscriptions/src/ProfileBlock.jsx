import '@shopify/ui-extensions/preact';
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

function tr(key) {
  if (typeof window === "undefined") return null;
  return (window.__sub_translations && window.__sub_translations[key]) || null;
}

function t(key, fallback) {
  var value = tr(key);
  return value === null || value === undefined || value === "" ? fallback : value;
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
    return null;
  }
}

function Extension() {
  var readyArr = useState(false);
  var ready = readyArr[0];
  var setReady = readyArr[1];

  useEffect(function() {
    getShopHost()
      .then(function(shopHost) {
        if (!shopHost) return false;
        return fetch("https://" + shopHost + "/apps/subscriptions/translations")
          .then(function(res) { return res.ok ? res.json() : null; })
          .then(function(data) {
            if (!data || typeof window === "undefined") return false;
            window.__sub_translations = data.translation || {};
            window.__sub_locale = data.effectiveLocale || data.preferredLocale || "en";
            return true;
          });
      })
      .finally(function() {
        setReady(true);
      });
  }, [setReady]);

  function handleClick() {
    shopify.navigation.navigate("extension:customer-subscriptions-dashboard");
  }

  return (
    <s-section heading={t("my_subscriptions", "My Subscriptions")}>
      <s-stack gap="base">
        <s-text>{t("profile_block_description", "View your active subscriptions and manage them.")}</s-text>
        <s-button onClick={handleClick}>
          {ready ? t("subscriptions_button", "Subscriptions") : "Subscriptions"}
        </s-button>
      </s-stack>
    </s-section>
  );
}
