type TranslateInput = {
  texts: Record<string, string>;
  targetLanguage: string;
};

export async function translateTextMap({
  texts,
  targetLanguage,
}: TranslateInput): Promise<Record<string, string>> {
  if (!texts || !targetLanguage || !Object.keys(texts).length) {
    return {};
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[translateTextMap] ANTHROPIC_API_KEY is not set");
    return {};
  }

  const prompt = `Translate the following JSON object values to ${targetLanguage}.
Rules:
- Keep every key exactly as-is.
- Translate only the values.
- Return ONLY valid JSON - no markdown, no code fences, no explanation.
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
      console.error("[translateTextMap] Anthropic error:", err);
      return {};
    }

    const data = await res.json();
    const raw =
      data.content
        ?.filter((chunk: any) => chunk.type === "text")
        .map((chunk: any) => chunk.text)
        .join("") ?? "{}";

    const clean = raw.replace(/```json|```/gi, "").trim();
    const parsed = JSON.parse(clean);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const translated: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        translated[key] = value;
      }
    }

    return translated;
  } catch (error) {
    console.error("[translateTextMap] fetch failed:", error);
    return {};
  }
}
