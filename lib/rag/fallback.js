// lib/rag/fallback.js
import openai from "../openaiClient.js";

/**
 * getGeneralAnswer(userQuery, conversationHistory)
 * Returns { answer, raw_urls }
 */
export async function getGeneralAnswer(userQuery, conversationHistory = []) {
  const historyText = (conversationHistory || []).slice(-6).map(m => `${m.role}: ${m.content}`).join("\n");
  const prompt = `
You are an assistant answering from general knowledge (NOT from verified sources).
Start with the disclaimer:
"Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions."

If conversation context is provided, use it to interpret follow-ups. The conversation (if any) is below:
${historyText ? historyText + "\n\n" : ""}

User question:
"""${userQuery}"""

If you used web pages in your reasoning, list their URLs at the end under a "Links:" section (one per line). Otherwise omit the Links section.
`;
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.0,
      max_tokens: 1100,
    });
    const text = resp?.choices?.[0]?.message?.content?.trim() || "";

    const urlRegex = /\bhttps?:\/\/[^\s)]+/g;
    const raw_urls = Array.from(new Set((text.match(urlRegex) || []).map((u) => u.replace(/[.,;)]*$/, ""))));
    return { answer: text, raw_urls };
  } catch (err) {
    console.warn("getGeneralAnswer error:", err?.message || err);
    return { answer: "Sorry — couldn't fetch a general answer right now.", raw_urls: [] };
  }
}
