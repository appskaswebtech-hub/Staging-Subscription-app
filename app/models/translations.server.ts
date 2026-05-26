
import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import { translateTextMap } from "../services/translate.server";

export const DEFAULT_LOCALE = "en";

const APP_SETTINGS_DEFAULTS = {
  notifyOnBillingFailure: true,
  notifyOnCancellation: true,
  notifyOnNewSubscription: false,
  notificationEmail: "",
  maxBillingRetries: 3,
  gracePeriodDays: 7,
  allowCustomerPause: true,
  allowCustomerCancel: true,
};

const LOCALE_LABELS: Record<string, string> = {
  en: "English",
  "zh-CN": "Chinese (Simplified)",
  "zh-TW": "Chinese (Traditional)",
  fr: "French",
  de: "German",
  ja: "Japanese",
  ko: "Korean",
  es: "Spanish",
  pt: "Portuguese",
  ar: "Arabic",
  hi: "Hindi",
  it: "Italian",
  nl: "Dutch",
  sv: "Swedish",
  pl: "Polish",
  tr: "Turkish",
};

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function normalizeShop(shop: string | null | undefined) {
  const value = String(shop ?? "").trim();
  if (!value) return "";

  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    return url.hostname.toLowerCase();
  } catch {
    return value
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      .toLowerCase();
  }
}

export function normalizeLocale(locale: string | null | undefined) {
  return String(locale ?? "").trim();
}

function handleize(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function localeLabel(locale: string) {
  const normalized = normalizeLocale(locale);
  return LOCALE_LABELS[normalized] || LOCALE_LABELS[normalized.split("-")[0]] || normalized;
}

function isEnglishLocale(locale: string) {
  return normalizeLocale(locale).toLowerCase().startsWith("en");
}

function sellingPlanGroupTranslationKey(name: string) {
  return `selling_plan_group__${handleize(name)}`;
}

type TableInfoRow = {
  name: string;
};

async function hasAppSettingsDefaultLocaleColumn() {
  try {
    const rows = await prisma.$queryRawUnsafe<TableInfoRow[]>(
      'PRAGMA table_info("AppSettings")',
    );

    return rows.some((row) => row.name === "defaultLocale");
  } catch (error) {
    console.warn("[translations] Could not inspect AppSettings schema:", error);
    return false;
  }
}

export function localeCandidates(locale: string | null | undefined) {
  const value = normalizeLocale(locale);
  if (!value) return [];

  const base = value.split("-")[0];
  return unique([value, base].filter(Boolean));
}

function coerceTranslationKeys(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};

  const dict: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      dict[key] = value;
    }
  }
  return dict;
}

function addAlias(target: Record<string, string>, key: string, value: string) {
  if (!key || key in target) return;
  target[key] = value;
}

export function toPublicTranslationDictionary(input: unknown) {
  const keys = coerceTranslationKeys(input);
  const publicDict: Record<string, string> = {};

  for (const [rawKey, value] of Object.entries(keys)) {
    addAlias(publicDict, rawKey, value);
    addAlias(publicDict, rawKey.replace(/__/g, "."), value);

    const fieldKey = rawKey.includes("__")
      ? rawKey.split("__").slice(1).join("__")
      : rawKey;

    addAlias(publicDict, fieldKey, value);

    if (fieldKey.endsWith("_label")) {
      addAlias(publicDict, fieldKey.slice(0, -"_label".length), value);
    }
    if (fieldKey.endsWith("_text")) {
      addAlias(publicDict, fieldKey.slice(0, -"_text".length), value);
    }
  }

  return publicDict;
}

export async function getTranslation(shop: string, locale: string) {
  const normalizedShop = normalizeShop(shop);
  const normalizedLocale = normalizeLocale(locale);
  if (!normalizedShop || !normalizedLocale) return null;

  const rec = await prisma.translation.findUnique({
    where: { shop_locale: { shop: normalizedShop, locale: normalizedLocale } as any },
  });
  return rec ? coerceTranslationKeys(rec.keys) : null;
}

export async function getTranslationsForShop(shop: string) {
  const normalizedShop = normalizeShop(shop);
  if (!normalizedShop) return [];

  return prisma.translation.findMany({
    where: { shop: normalizedShop },
    orderBy: [{ updatedAt: "desc" }, { locale: "asc" }],
  });
}

export async function upsertTranslation(shop: string, locale: string, keys: Record<string, string>) {
  const normalizedShop = normalizeShop(shop);
  const normalizedLocale = normalizeLocale(locale);

  return prisma.translation.upsert({
    where: { shop_locale: { shop: normalizedShop, locale: normalizedLocale } as any },
    create: { shop: normalizedShop, locale: normalizedLocale, keys },
    update: { keys },
  });
}

async function ensureSellingPlanGroupTranslations(shop: string, locale: string) {
  const normalizedShop = normalizeShop(shop);
  const normalizedLocale = normalizeLocale(locale);

  if (!normalizedShop || !normalizedLocale || isEnglishLocale(normalizedLocale)) {
    return;
  }

  const planGroups = await prisma.sellingPlanGroup.findMany({
    where: { shop: normalizedShop },
    select: { name: true },
    orderBy: { createdAt: "asc" },
  });

  if (!planGroups.length) {
    return;
  }

  const existingKeys = (await getTranslation(normalizedShop, normalizedLocale)) ?? {};
  const missingTexts: Record<string, string> = {};

  for (const group of planGroups) {
    const key = sellingPlanGroupTranslationKey(group.name);
    if (!key || existingKeys[key]) continue;
    missingTexts[key] = group.name;
  }

  if (!Object.keys(missingTexts).length) {
    return;
  }

  const translated = await translateTextMap({
    texts: missingTexts,
    targetLanguage: localeLabel(normalizedLocale),
  });

  if (!Object.keys(translated).length) {
    return;
  }

  await upsertTranslation(normalizedShop, normalizedLocale, {
    ...existingKeys,
    ...translated,
  });
}

export async function setShopDefaultLocale(shop: string, locale: string) {
  const normalizedShop = normalizeShop(shop);
  const normalizedLocale = normalizeLocale(locale) || DEFAULT_LOCALE;
  if (!normalizedShop) return null;

  if (!(await hasAppSettingsDefaultLocaleColumn())) {
    return null;
  }

  try {
    await prisma.$executeRawUnsafe(
      `
        INSERT INTO "AppSettings" (
          "id",
          "shop",
          "defaultLocale",
          "notifyOnBillingFailure",
          "notifyOnCancellation",
          "notifyOnNewSubscription",
          "notificationEmail",
          "maxBillingRetries",
          "gracePeriodDays",
          "allowCustomerPause",
          "allowCustomerCancel",
          "createdAt",
          "updatedAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT("shop") DO UPDATE SET
          "defaultLocale" = excluded."defaultLocale",
          "updatedAt" = CURRENT_TIMESTAMP
      `,
      `app_settings_${randomUUID()}`,
      normalizedShop,
      normalizedLocale,
      APP_SETTINGS_DEFAULTS.notifyOnBillingFailure,
      APP_SETTINGS_DEFAULTS.notifyOnCancellation,
      APP_SETTINGS_DEFAULTS.notifyOnNewSubscription,
      APP_SETTINGS_DEFAULTS.notificationEmail,
      APP_SETTINGS_DEFAULTS.maxBillingRetries,
      APP_SETTINGS_DEFAULTS.gracePeriodDays,
      APP_SETTINGS_DEFAULTS.allowCustomerPause,
      APP_SETTINGS_DEFAULTS.allowCustomerCancel,
    );
    return { shop: normalizedShop, defaultLocale: normalizedLocale };
  } catch (error) {
    console.warn("[translations] Could not persist shop default locale:", error);
    return null;
  }
}

export async function getShopDefaultLocale(shop: string) {
  const normalizedShop = normalizeShop(shop);
  if (!normalizedShop) return DEFAULT_LOCALE;

  if (await hasAppSettingsDefaultLocaleColumn()) {
    try {
      const rows = await prisma.$queryRawUnsafe<Array<{ defaultLocale: string | null }>>(
        'SELECT "defaultLocale" as "defaultLocale" FROM "AppSettings" WHERE "shop" = ? LIMIT 1',
        normalizedShop,
      );
      const storedLocale = normalizeLocale(rows[0]?.defaultLocale);
      if (storedLocale) {
        return storedLocale;
      }
    } catch (error) {
      console.warn("[translations] Could not read shop default locale:", error);
    }
  }

  const latestTranslation = await prisma.translation.findFirst({
    where: { shop: normalizedShop },
    orderBy: { updatedAt: "desc" },
    select: { locale: true },
  });

  return latestTranslation?.locale ?? DEFAULT_LOCALE;
}

export async function resolveTranslationForShop(
  shop: string,
  requestedLocale?: string | null,
) {
  const normalizedShop = normalizeShop(shop);
  const preferredLocale = await getShopDefaultLocale(normalizedShop);
  const normalizedRequestedLocale = normalizeLocale(requestedLocale);

  if (!normalizedShop) {
    return {
      shop: "",
      requestedLocale: normalizedRequestedLocale || null,
      preferredLocale,
      effectiveLocale: preferredLocale,
      availableLocales: [] as string[],
      translation: {} as Record<string, string>,
    };
  }

  const localesToPrime = unique([
    ...localeCandidates(normalizedRequestedLocale),
    ...localeCandidates(preferredLocale),
  ]);

  for (const locale of localesToPrime) {
    await ensureSellingPlanGroupTranslations(normalizedShop, locale);
  }

  const records = await prisma.translation.findMany({
    where: { shop: normalizedShop },
    select: { locale: true, keys: true, updatedAt: true },
    orderBy: [{ updatedAt: "desc" }, { locale: "asc" }],
  });

  const candidates = unique([
    ...localeCandidates(normalizedRequestedLocale),
    ...localeCandidates(preferredLocale),
  ]);

  let resolvedRecord = null;
  for (const candidate of candidates) {
    resolvedRecord = records.find((record) => record.locale === candidate) ?? null;
    if (resolvedRecord) break;
  }

  if (!resolvedRecord) {
    resolvedRecord = records[0] ?? null;
  }

  return {
    shop: normalizedShop,
    requestedLocale: normalizedRequestedLocale || null,
    preferredLocale,
    effectiveLocale: resolvedRecord?.locale ?? preferredLocale,
    availableLocales: records.map((record) => record.locale),
    translation: resolvedRecord ? toPublicTranslationDictionary(resolvedRecord.keys) : {},
  };
}
