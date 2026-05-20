import prisma from "../app/db.server";
import { syncSubscriptionsFromShopify } from "../app/shopify/subscriptionContracts.server";

async function main() {
  const requestedShop = process.argv[2]?.trim();

  const session = requestedShop
    ? await prisma.session.findFirst({
        where: { shop: requestedShop },
        orderBy: { isOnline: "asc" },
      })
    : await prisma.session.findFirst({
        where: { shop: { not: "" } },
        orderBy: { isOnline: "asc" },
      });

  if (!session) {
    throw new Error(
      requestedShop
        ? `No session found for shop ${requestedShop}`
        : "No Shopify session found in local database",
    );
  }

  const admin = {
    graphql: (query: string, options: { variables?: Record<string, unknown> } = {}) =>
      fetch(`https://${session.shop}/admin/api/2026-04/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": session.accessToken,
        },
        body: JSON.stringify({
          query,
          variables: options.variables ?? {},
        }),
      }),
  };

  const synced = await syncSubscriptionsFromShopify(admin, session.shop);

  console.log(
    JSON.stringify(
      {
        shop: session.shop,
        synced: synced.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
