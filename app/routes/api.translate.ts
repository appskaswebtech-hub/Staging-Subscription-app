/**
 * Resource route: POST /api/translate
 *
 * Body: { texts: Record<string, string>, targetLanguage: string }
 * Returns: Record<string, string>  — same keys, translated values
 *
 * Place this file at:  app/routes/api.translate.ts
 *
 * Requires env var:  ANTHROPIC_API_KEY
 */

import type { ActionArgs } from "@remix-run/node";
import { translateTextMap } from "../services/translate.server";

export async function action({ request }: ActionArgs) {
  const { texts, targetLanguage } = (await request.json()) as {
    texts: Record<string, string>;
    targetLanguage: string;
  };

  if (!texts || !targetLanguage) {
    return new Response(JSON.stringify({}), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const translated = await translateTextMap({ texts, targetLanguage });
    return new Response(JSON.stringify(translated), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[api/translate] fetch failed:", err);
    return new Response(JSON.stringify({}), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
