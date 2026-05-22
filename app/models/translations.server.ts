
import prisma from "../db.server";

export async function getTranslation(shop: string, locale: string) {
  if (!shop || !locale) return null;
  const rec = await prisma.translation.findUnique({
    where: { shop_locale: { shop, locale } as any },
  });
  return rec ? (rec.keys as Record<string,string>) : null;
}

export async function getTranslationsForShop(shop: string) {
  return prisma.translation.findMany({ where: { shop } });
}

export async function upsertTranslation(shop: string, locale: string, keys: Record<string,string>) {
  return prisma.translation.upsert({
    where: { shop_locale: { shop, locale } as any },
    create: { shop, locale, keys },
    update: { keys },
  });
}
