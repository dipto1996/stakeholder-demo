// lib/rag/fallback.js
import openai from "../openaiClient.js";

/**
 * getGeneralAnswer(userQuery)
 * returns { answer, sources: [], links: [url strings], disclaimer }
 *
 * The fallback model is allowed to produce URLs; we will not treat them as verified.
 * Caller can optionally perform link verification.
 */
export async function getGeneralAnswer(userQuery) {
  const prompt = `
You are an assistant answering from general knowledge (NOT from the application's verified sources).
Start with the exact disclaimer line:
"Disclaimer: Based on general knowledge (not our verified sources). Please consult official sources for legal decisions."
Then provide a concise, helpful answer to:
"${userQuery}"
If you can, list any URLs you used or which are relevant, under a heading "References:" as bullet URLs (but do NOT invent URLs).
Do not invent statutes or claim access to internal documents.
`;
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.0,
      max_tokens: 700,
    });
    const text = resp?.choices?.[0]?.message?.content?.trim() || "";
    // Try to extract reference URLs (simple regex)
    const urlRegex = /(https?:\/\/[^\s)]+)/g;
    const links = (text.match(urlRegex) || []).map((s) => s.replace(/[.)]$/, ""));
    return { answer: text, sources: [], links, disclaimer: "Disclaimer: Based on general knowledge (not our verified sources). Please consult official sources for legal decisions." };
  } catch (err) {
    console.warn("getGeneralAnswer error:", err?.message || err);
    return { answer: "Sorry — I couldn't fetch a general answer right now.", sources: [], links: [], disclaimer: null };
  }
}
