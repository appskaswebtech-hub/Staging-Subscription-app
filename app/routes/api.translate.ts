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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[api/translate] ANTHROPIC_API_KEY is not set");
    return new Response(JSON.stringify({}), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const prompt = `Translate the following JSON object values to ${targetLanguage}.
Rules:
- Keep every key exactly as-is.
- Translate only the values.
- Return ONLY valid JSON — no markdown, no code fences, no explanation.
- Keep translations short and UI-friendly (labels, button text, descriptions).

Input JSON:
${JSON.stringify(texts, null, 2)}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("[api/translate] Anthropic error:", err);
      return new Response(JSON.stringify({}), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = await res.json();
    const raw: string =
      data.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("") ?? "{}";

    // Strip any accidental markdown fences
    const clean = raw.replace(/```json|```/gi, "").trim();

    return new Response(clean, {
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