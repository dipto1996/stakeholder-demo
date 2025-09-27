// lib/rag/fallback.js
import openai from "../openaiClient.js";

export async function getGeneralAnswer(userQuery) {
  const prompt = `
You are an assistant answering from general knowledge (NOT the application's verified sources).
Start with: "Disclaimer: Based on general knowledge (not our verified sources). Please consult official sources for legal decisions."
Then provide a concise, helpful answer to:
"${userQuery}"
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
    return { answer: text, sources: [], disclaimer: "Disclaimer: Based on general knowledge (not our verified sources). Please consult official sources for legal decisions." };
  } catch (err) {
    console.warn("getGeneralAnswer error:", err?.message || err);
    return { answer: "Sorry — I couldn't fetch a general answer right now.", sources: [], disclaimer: null };
  }
}
