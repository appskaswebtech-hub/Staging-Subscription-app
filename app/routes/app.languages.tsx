import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import { useState, useCallback, useRef } from "react";
import type { LoaderArgs, ActionArgs } from "@remix-run/node";
import { getTranslationsForShop, upsertTranslation } from "../models/translations.server";

// ─── Types ───────────────────────────────────────────────────────────────────

type SectionKey =
  | "subscription_widget"
  | "auto_charging_widget"
  | "subscribe_now_button"
  | "recurring_invoices_widget"
  | "recurring_invoices_cart_labels"
  | "interval_labels";

interface TranslationSection {
  key: SectionKey;
  label: string;
  icon: string;
  description: string;
  fields: { key: string; label: string; multiline?: boolean; defaultEnglish: string }[];
}

// ─── Section / field config ──────────────────────────────────────────────────

const SECTIONS: TranslationSection[] = [
  {
    key: "subscription_widget",
    label: "Subscription widget",
    icon: "🔄",
    description: "These values are used in auto-charging and recurring invoices widgets.",
    fields: [
      { key: "one_time_label",        label: "One time option label",        defaultEnglish: "One-time purchase" },
      { key: "one_time_description",  label: "One time option description",  defaultEnglish: "Buy once, no commitment.", multiline: true },
      { key: "subscribe_label",       label: "Subscribe option label",       defaultEnglish: "Subscribe" },
      { key: "subscribe_description", label: "Subscribe option description", defaultEnglish: "Subscribe and save on every order.", multiline: true },
    ],
  },
  {
    key: "auto_charging_widget",
    label: "Auto-charging widget",
    icon: "💳",
    description: "Labels shown on the auto-charge confirmation screen.",
    fields: [
      { key: "charge_button",     label: "Charge button label", defaultEnglish: "Charge now" },
      { key: "cancel_button",     label: "Cancel button label", defaultEnglish: "Cancel" },
      { key: "next_charge_label", label: "Next charge label",   defaultEnglish: "Next charge date" },
    ],
  },
  {
    key: "subscribe_now_button",
    label: "Subscribe now button",
    icon: "🖱️",
    description: "Text shown on the main subscribe call-to-action button.",
    fields: [
      { key: "button_text",         label: "Button text",        defaultEnglish: "Subscribe now" },
      { key: "button_loading_text", label: "Loading state text", defaultEnglish: "Processing…" },
    ],
  },
  {
    key: "recurring_invoices_widget",
    label: "Recurring invoices widget",
    icon: "🧾",
    description: "Labels used on invoice display widget.",
    fields: [
      { key: "invoice_header", label: "Invoice header label", defaultEnglish: "Invoice" },
      { key: "due_date_label", label: "Due date label",       defaultEnglish: "Due date" },
      { key: "total_label",    label: "Total label",          defaultEnglish: "Total" },
    ],
  },
  {
    key: "recurring_invoices_cart_labels",
    label: "Recurring invoices cart labels",
    icon: "🛒",
    description: "Labels shown in the cart for recurring orders.",
    fields: [
      { key: "recurring_label", label: "Recurring order label", defaultEnglish: "Recurring order" },
      { key: "frequency_label", label: "Frequency label",       defaultEnglish: "Delivery frequency" },
    ],
  },
  {
    key: "interval_labels",
    label: "Interval labels",
    icon: "📅",
    description: "Delivery interval labels shown throughout the widget.",
    fields: [
      { key: "daily",   label: "Daily",   defaultEnglish: "Daily" },
      { key: "weekly",  label: "Weekly",  defaultEnglish: "Weekly" },
      { key: "monthly", label: "Monthly", defaultEnglish: "Monthly" },
      { key: "yearly",  label: "Yearly",  defaultEnglish: "Yearly" },
    ],
  },
];

const LANGUAGES = [
  { value: "zh-CN", label: "Chinese (Simplified)" },
  { value: "zh-TW", label: "Chinese (Traditional)" },
  { value: "fr",    label: "French" },
  { value: "de",    label: "German" },
  { value: "ja",    label: "Japanese" },
  { value: "ko",    label: "Korean" },
  { value: "es",    label: "Spanish" },
  { value: "pt",    label: "Portuguese" },
  { value: "ar",    label: "Arabic" },
  { value: "hi",    label: "Hindi" },
  { value: "it",    label: "Italian" },
  { value: "nl",    label: "Dutch" },
  { value: "sv",    label: "Swedish" },
  { value: "pl",    label: "Polish" },
  { value: "tr",    label: "Turkish" },
];

// ─── Loader ──────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderArgs) {
  const url    = new URL(request.url);
  const shop   = url.searchParams.get("shop")   || "dev-shop.myshopify.com";
  const locale = url.searchParams.get("locale") || "zh-CN";
  const translations = await getTranslationsForShop(shop);
  return json({ shop, locale, translations });
}

// ─── Action ──────────────────────────────────────────────────────────────────

export async function action({ request }: ActionArgs) {
  const form   = await request.formData();
  const shop   = String(form.get("shop")   || "dev-shop.myshopify.com");
  const locale = String(form.get("locale") || "zh-CN");

  const keys: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (k.startsWith("field_")) {
      keys[k.replace(/^field_/, "")] = String(v ?? "");
    }
  }

  await upsertTranslation(shop, locale, keys);

  return redirect(
    `/app/languages?shop=${encodeURIComponent(shop)}&locale=${encodeURIComponent(locale)}`
  );
}

// ─── Auto-translate helper ────────────────────────────────────────────────────

async function autoTranslate(
  targetLangLabel: string,
  fields: TranslationSection["fields"]
): Promise<Record<string, string>> {
  const input: Record<string, string> = {};
  fields.forEach((f) => { input[f.key] = f.defaultEnglish; });

  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: input, targetLanguage: targetLangLabel }),
    });
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

// ─── Build empty field map for a locale ──────────────────────────────────────

function buildFieldMap(keys: Record<string, string>): Record<string, string> {
  const map: Record<string, string> = {};
  SECTIONS.forEach((section) => {
    section.fields.forEach((f) => {
      const compositeKey = `${section.key}__${f.key}`;
      // DB stores keys as "subscription_widget__one_time_label" — match exactly
      map[compositeKey] = keys[compositeKey] ?? "";
    });
  });
  return map;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function LanguagesAdmin() {
  const { shop, locale: initialLocale, translations } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSaving   = navigation.state === "submitting";

  // ── Per-locale cache: locale → fieldValues map ─────────────────────────────
  // Seeded from DB (loader) for every locale we already have data for.
  const localeCache = useRef<Record<string, Record<string, string>>>({});
  // populate cache from loader translations immediately (safe on first render)
  (translations as any[]).forEach((t: any) => {
    localeCache.current[t.locale] = buildFieldMap(t.keys ?? {});
  });

  const [selectedLocale,  setSelectedLocale]  = useState(initialLocale);
  const [activeSection,   setActiveSection]   = useState<SectionKey>("subscription_widget");
  const [isTranslating,   setIsTranslating]   = useState(false);
  const [toast,           setToast]           = useState<{ msg: string; ok: boolean } | null>(null);

  // Current field values come from the cache for the selected locale
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(
    () => localeCache.current[initialLocale] ?? buildFieldMap({})
  );

  const currentSection = SECTIONS.find((s) => s.key === activeSection)!;

  // ── Save current edits into cache before switching locale ─────────────────
  const flushToCache = useCallback(
    (locale: string, values: Record<string, string>) => {
      localeCache.current[locale] = { ...values };
    },
    []
  );

  // ── Language change ───────────────────────────────────────────────────────
  const handleLocaleChange = useCallback(
    async (newLocale: string) => {
      // 1. Save whatever user has typed right now into cache for current locale
      flushToCache(selectedLocale, fieldValues);

      // 2. Switch locale state
      setSelectedLocale(newLocale);

      // 3a. Cache already has values for this locale (from DB or previous translate)
      if (
        localeCache.current[newLocale] &&
        Object.values(localeCache.current[newLocale]).some((v) => v !== "")
      ) {
        setFieldValues(localeCache.current[newLocale]);
        return;
      }

      // 3b. No data yet → auto-translate from English defaults
      const langLabel = LANGUAGES.find((l) => l.value === newLocale)?.label ?? newLocale;
      setIsTranslating(true);

      try {
        const results: Record<string, string> = {};

        await Promise.all(
          SECTIONS.map(async (section) => {
            const translated = await autoTranslate(langLabel, section.fields);
            section.fields.forEach((f) => {
              results[`${section.key}__${f.key}`] = translated[f.key] ?? "";
            });
          })
        );

        localeCache.current[newLocale] = results;
        setFieldValues(results);
      } finally {
        setIsTranslating(false);
      }
    },
    [selectedLocale, fieldValues, flushToCache]
  );

  // ── Field helpers ─────────────────────────────────────────────────────────
  const getValue = (sectionKey: SectionKey, fieldKey: string) =>
    fieldValues[`${sectionKey}__${fieldKey}`] ?? "";

  const setValue = (sectionKey: SectionKey, fieldKey: string, val: string) => {
    setFieldValues((prev) => {
      const next = { ...prev, [`${sectionKey}__${fieldKey}`]: val };
      // Keep cache in sync with every keystroke
      localeCache.current[selectedLocale] = next;
      return next;
    });
  };

  // ── Toast helper ──────────────────────────────────────────────────────────
  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  };

  // ── After save redirect: show success toast ───────────────────────────────
  // (navigation idle after submitting = save done)
  const prevState = useRef(navigation.state);
  if (prevState.current === "submitting" && navigation.state === "idle") {
    prevState.current = navigation.state;
    // showToast is fine to call here because it just sets state
    setTimeout(() => showToast("Translations saved successfully!", true), 50);
  } else {
    prevState.current = navigation.state;
  }

  return (
    <div style={styles.page}>

      {/* ── Toast ───────────────────────────────────────────────────────── */}
      {toast && (
        <div style={{ ...styles.toast, background: toast.ok ? "#008060" : "#d82c0d" }}>
          {toast.ok ? "✓ " : "✕ "}{toast.msg}
        </div>
      )}

      {/* ── Language Selector ────────────────────────────────────────────── */}
      <div style={styles.localeBlock}>
        <label style={styles.localeLabel}>Editing translations for</label>
        <div style={{ position: "relative" }}>
          <select
            style={{
              ...styles.localeSelect,
              opacity: isTranslating ? 0.6 : 1,
              pointerEvents: isTranslating ? "none" : "auto",
            }}
            value={selectedLocale}
            onChange={(e) => handleLocaleChange(e.target.value)}
          >
            {LANGUAGES.map((lang) => (
              <option key={lang.value} value={lang.value}>
                {lang.label}
              </option>
            ))}
          </select>
          {isTranslating && (
            <span style={styles.translatingBadge}>
              <span style={styles.spinner} />
              Auto-translating…
            </span>
          )}
        </div>
        <p style={styles.localeHint}>
          Select a language — fields will be auto-translated instantly. You can edit any
          value before saving. Switching languages preserves your unsaved edits.
        </p>
      </div>

      {/* ── Info Banner ───────────────────────────────────────────────── */}
      <div style={styles.infoBanner}>
        <span style={styles.infoIcon}>ℹ️</span>
        <span>
          Currently, you have to manually translate/modify texts on this page and save them.
          However, our team is diligently developing a new feature that will automatically
          translate text into various languages, streamlining the process for you.
        </span>
      </div>


      {/* ── Two-column layout ────────────────────────────────────────────── */}
      <div style={styles.twoCol}>

        {/* Left: radio nav */}
        <div style={styles.leftPanel}>
          <p style={styles.panelHeading}>Translations</p>
          {SECTIONS.map((section) => (
            <label key={section.key} style={styles.radioRow}>
              <input
                type="radio"
                name="section_nav"
                value={section.key}
                checked={activeSection === section.key}
                onChange={() => setActiveSection(section.key)}
                style={styles.radioInput}
              />
              <span
                style={{
                  ...styles.radioLabel,
                  ...(activeSection === section.key ? styles.radioLabelActive : {}),
                }}
              >
                <span style={styles.sectionIcon}>{section.icon}</span>
                {section.label}
              </span>
            </label>
          ))}
        </div>

        {/* Right: form */}
        <div style={styles.rightPanel}>

          {/* Translating overlay */}
          {isTranslating && (
            <div style={styles.overlay}>
              <div style={styles.overlayBox}>
                <span style={{ ...styles.spinner, width: 22, height: 22, borderWidth: 3 }} />
                <span style={{ fontSize: 14, color: "#202223" }}>
                  Translating to{" "}
                  <strong>{LANGUAGES.find((l) => l.value === selectedLocale)?.label}</strong>…
                </span>
              </div>
            </div>
          )}

          <Form method="post">
            <input type="hidden" name="shop"   value={shop} />
            <input type="hidden" name="locale" value={selectedLocale} />

            {/* Hidden inputs for ALL sections — so one Save saves everything */}
            {SECTIONS.flatMap((section) =>
              section.fields.map((f) => (
                <input
                  key={`${section.key}__${f.key}`}
                  type="hidden"
                  name={`field_${section.key}__${f.key}`}
                  value={getValue(section.key, f.key)}
                />
              ))
            )}

            <div style={styles.formHeader}>
              <h2 style={styles.formTitle}>{currentSection.label}</h2>
              <p style={styles.formDesc}>{currentSection.description}</p>
            </div>

            <div style={styles.fieldList}>
              {currentSection.fields.map((field) => {
                const val = getValue(activeSection, field.key);
                return (
                  <div key={field.key} style={styles.field}>
                    <label style={styles.fieldLabel}>{field.label}</label>
                    {field.multiline ? (
                      <textarea
                        value={val}
                        onChange={(e) => setValue(activeSection, field.key, e.target.value)}
                        style={{ ...styles.input, ...styles.textarea }}
                        placeholder={`Enter ${field.label.toLowerCase()}…`}
                        disabled={isTranslating}
                      />
                    ) : (
                      <input
                        type="text"
                        value={val}
                        onChange={(e) => setValue(activeSection, field.key, e.target.value)}
                        style={{
                          ...styles.input,
                          background: isTranslating ? "#f6f6f7" : "#fff",
                        }}
                        placeholder={`Enter ${field.label.toLowerCase()}…`}
                        disabled={isTranslating}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            <div style={styles.saveRow}>
              <button
                type="submit"
                disabled={isSaving || isTranslating}
                style={{
                  ...styles.saveBtn,
                  opacity:  isSaving || isTranslating ? 0.6 : 1,
                  cursor:   isSaving || isTranslating ? "not-allowed" : "pointer",
                }}
              >
                {isSaving ? "Saving…" : "Save translations"}
              </button>
            </div>
          </Form>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  page: {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    maxWidth: 900,
    margin: "0 auto",
    padding: "24px 20px",
    color: "#202223",
    position: "relative",
  },

  // Toast
  toast: {
    position: "fixed",
    top: 20,
    right: 20,
    color: "#fff",
    fontSize: 14,
    fontWeight: 500,
    padding: "10px 18px",
    borderRadius: 6,
    boxShadow: "0 4px 12px rgba(0,0,0,.18)",
    zIndex: 9999,
    transition: "opacity .3s",
  },

  // Locale selector
  localeBlock: { marginBottom: 20 },
  localeLabel: {
    display: "block",
    fontSize: 13,
    color: "#6d7175",
    marginBottom: 6,
  },
  localeSelect: {
    width: "100%",
    padding: "8px 12px",
    fontSize: 14,
    border: "1px solid #aeb4b9",
    borderRadius: 6,
    background: "#fff",
    color: "#202223",
    cursor: "pointer",
    appearance: "auto",
    transition: "opacity .2s",
  },
  translatingBadge: {
    position: "absolute",
    right: 12,
    top: "50%",
    transform: "translateY(-50%)",
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "#008060",
    fontWeight: 500,
    pointerEvents: "none",
  },
  spinner: {
    display: "inline-block",
    width: 12,
    height: 12,
    border: "2px solid #c9ede4",
    borderTopColor: "#008060",
    borderRadius: "50%",
    animation: "spin 0.7s linear infinite",
  },
  localeHint: {
    fontSize: 13,
    color: "#6d7175",
    marginTop: 8,
    lineHeight: 1.5,
  },

  // Layout
  twoCol: {
    display: "flex",
    border: "1px solid #e1e3e5",
    borderRadius: 8,
    overflow: "hidden",
    background: "#fff",
    position: "relative",
  },

  // Left panel
  leftPanel: {
    width: 260,
    flexShrink: 0,
    borderRight: "1px solid #e1e3e5",
    padding: "16px 0",
  },
  panelHeading: {
    fontSize: 13,
    fontWeight: 600,
    color: "#202223",
    padding: "0 16px 12px",
    borderBottom: "1px solid #e1e3e5",
    marginBottom: 8,
  },
  radioRow: {
    display: "flex",
    alignItems: "center",
    cursor: "pointer",
    padding: "2px 12px",
  },
  radioInput: {
    marginRight: 8,
    accentColor: "#008060",
    cursor: "pointer",
    width: 15,
    height: 15,
    flexShrink: 0,
  },
  radioLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 14,
    color: "#6d7175",
    padding: "7px 4px",
    borderRadius: 4,
    flex: 1,
  },
  radioLabelActive: {
    color: "#008060",
    fontWeight: 500,
  },
  sectionIcon: { fontSize: 15, lineHeight: 1 },

  // Right panel
  rightPanel: {
    flex: 1,
    padding: "24px 28px",
    position: "relative",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    background: "rgba(255,255,255,.78)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  overlayBox: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    background: "#fff",
    border: "1px solid #e1e3e5",
    borderRadius: 8,
    padding: "14px 20px",
    boxShadow: "0 2px 8px rgba(0,0,0,.08)",
  },
  formHeader: {
    marginBottom: 20,
    paddingBottom: 16,
    borderBottom: "1px solid #e1e3e5",
  },
  formTitle: {
    fontSize: 16,
    fontWeight: 600,
    margin: "0 0 4px",
    color: "#202223",
  },
  formDesc: { fontSize: 13, color: "#6d7175", margin: 0 },
  fieldList: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  fieldLabel: { fontSize: 13, fontWeight: 500, color: "#202223" },
  input: {
    width: "100%",
    padding: "8px 12px",
    fontSize: 14,
    border: "1px solid #aeb4b9",
    borderRadius: 6,
    color: "#202223",
    background: "#fff",
    outline: "none",
    boxSizing: "border-box",
    transition: "background .2s",
  },
  textarea: {
    minHeight: 72,
    resize: "vertical",
    lineHeight: 1.5,
  },
  saveRow: {
    marginTop: 24,
    paddingTop: 16,
    borderTop: "1px solid #e1e3e5",
    display: "flex",
    justifyContent: "flex-end",
  },
  saveBtn: {
    background: "#008060",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "9px 20px",
    fontSize: 14,
    fontWeight: 500,
    transition: "opacity .2s",
  },
};