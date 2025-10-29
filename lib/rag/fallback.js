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
  
  const systemPrompt = `You are an expert U.S. immigration assistant providing general knowledge when specific documents aren't available.

IMPORTANT: This is general knowledge, not from verified sources.

Your answer should:
1. Start with: "⚠️ Note: This is based on general knowledge. For official guidance, consult USCIS.gov or an immigration attorney."
2. Provide helpful, commonly-known immigration information
3. Suggest relevant official resources (USCIS pages, forms)
4. Be transparent about uncertainty: "This typically..." or "Requirements may vary..."

Structure when appropriate:
**Brief Answer:** (1-2 sentences)
**Key Points:** (2-4 bullets of main facts)
**Important Notes:** (caveats, variations)
**Helpful Resources:** (USCIS links if relevant)`;

  const userPrompt = `
Conversation history:
${hist || "(None)"}

User question:
${userQuery}

Provide a helpful answer with the structure and disclaimer noted above.`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 800,
    temperature: 0.2,
  });

  const raw = resp?.choices?.[0]?.message?.content || "";
  const urlRegex = /\bhttps?:\/\/[^\s)]+/gi;
  const urls = Array.from(new Set((raw.match(urlRegex) || []).map(u => u.replace(/[),.]*$/, ""))));
  return { answer: raw, raw_urls: urls };
}
