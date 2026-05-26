import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { addCorsHeaders } from "../shopify.server";
import { resolveTranslationForShop } from "../models/translations.server";

function getShopFromRequest(request: Request) {
  const url = new URL(request.url);

  return (
    url.searchParams.get("shop") ||
    url.searchParams.get("shopify_shop_domain") ||
    request.headers.get("x-shopify-shop-domain") ||
    ""
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: addCorsHeaders({ "Cache-Control": "no-store" }),
    });
  }

  const url = new URL(request.url);
  const shop = getShopFromRequest(request);
  const locale = url.searchParams.get("locale");

  if (!shop) {
    return json(
      { error: "Missing shop" },
      { status: 400, headers: addCorsHeaders({ "Cache-Control": "no-store" }) },
    );
  }

  const payload = await resolveTranslationForShop(shop, locale);

  return json(payload, {
    headers: addCorsHeaders({ "Cache-Control": "no-store" }),
  });
}
