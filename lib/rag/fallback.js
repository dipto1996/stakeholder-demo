// lib/rag/fallback.js
import openai from "../openaiClient.js";

/**
 * getGeneralAnswer(userQuery, conversationHistory)
 * Returns: { answer: string, raw_urls: string[] }
 * - answer: raw model text (may contain URLs). The caller will strip URLs if desired.
 * - raw_urls: extracted URLs from the model output (unique)
 */
export async function getGeneralAnswer(userQuery, conversationHistory = []) {
  const hist = (conversationHistory || []).slice(-6).map(m => `${m.role}: ${m.content}`).join("\n");
  const prompt = `
You are an assistant answering general questions about U.S. immigration. Use the recent conversation (if any) when relevant.
Answer concisely. If you include any URLs, append a "Links:" block at the end listing one URL per line.

Conversation history:
${hist}

User question:
${userQuery}
`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini", // Changed from gpt-4o for faster response (3-5x faster)
    messages: [
      { role: "system", content: "Answer succinctly. If you mention external URLs, include them in a 'Links:' block at the end, one per line." },
      { role: "user", content: prompt },
    ],
    max_tokens: 600, // Reduced from 800 for faster generation
    temperature: 0.2,
  });

  const raw = resp?.choices?.[0]?.message?.content || "";
  const urlRegex = /\bhttps?:\/\/[^\s)]+/gi;
  const urls = Array.from(new Set((raw.match(urlRegex) || []).map(u => u.replace(/[),.]*$/, ""))));
  return { answer: raw, raw_urls: urls };
}
