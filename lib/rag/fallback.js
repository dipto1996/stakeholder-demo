// lib/rag/fallback.js
import openai from "../openaiClient.js";

/**
 * getGeneralAnswer(userQuery, conversationHistory)
 * Returns: { answer: string, raw_urls: string[] }
 * The answer should be cleaned (we still return raw_urls so the API can verify and map to sources).
 */
export async function getGeneralAnswer(userQuery, conversationHistory = []) {
  const hist = (conversationHistory || []).slice(-6).map(m => `${m.role}: ${m.content}`).join("\n");
  const prompt = `
You are an assistant answering general questions about U.S. immigration. Answer based on your general knowledge and if you include any URLs, include them in a "Links:" block at the end, one per line.

Conversation history:
${hist}

User question:
${userQuery}
`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "Answer briefly and include a 'Links:' block if you reference external sites." },
      { role: "user", content: prompt },
    ],
    max_tokens: 700,
    temperature: 0.2,
  });

  const raw = resp?.choices?.[0]?.message?.content || "";
  // extract urls with regex
  const urlRegex = /\bhttps?:\/\/[^\s)]+/gi;
  const urls = Array.from(new Set((raw.match(urlRegex) || []).map(u => u.replace(/[),.]*$/, ""))));
  return { answer: raw, raw_urls: urls };
}
