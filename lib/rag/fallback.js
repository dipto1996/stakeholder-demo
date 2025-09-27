// lib/rag/fallback.js
import openai from "../openaiClient.js";

/**
 * getGeneralAnswer(userQuery)
 * returns { answer, raw_urls: [url strings] }
 */
export async function getGeneralAnswer(userQuery) {
  const prompt = `
You are an assistant answering from general knowledge (NOT from our verified sources).
Start with: "Disclaimer: Based on general knowledge (not our verified sources). Please consult official sources for legal decisions."
Then provide a concise and helpful answer to:
"${userQuery}"
At the end, if you can, list any web URLs (one per line) that you used to inform this answer. Return the answer and then a "URLs:" section listing links.
Do not invent statutes or claim access to internal documents.
`;
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.0,
      max_tokens: 900,
    });
    const text = resp?.choices?.[0]?.message?.content?.trim() || "";
    // Extract URLs (simple regex). We will verify them server-side after return.
    const urlRegex = /\bhttps?:\/\/[^\s)]+/g;
    const raw_urls = Array.from(new Set((text.match(urlRegex) || []).map((u) => u.replace(/[.,;)]*$/, ""))));
    return { answer: text, raw_urls };
  } catch (err) {
    console.warn("getGeneralAnswer error:", err?.message || err);
    return { answer: "Sorry — couldn't fetch a general answer right now.", raw_urls: [] };
  }
}
