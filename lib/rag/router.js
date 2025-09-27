// lib/rag/router.js
import openai from "../openaiClient.js";

/**
 * routeQuery(userQuery, conversationHistory)
 * Returns { refined_query, intent, format }
 * Uses conversationHistory (array of previous messages) to form the refined query.
 */
export async function routeQuery(userQuery, conversationHistory = []) {
  const lastTurns = (conversationHistory || []).slice(-6).map(m => `${m.role}: ${m.content}`).join("\n");
  const prompt = `
You are a fast, deterministic query rewriter for an immigration RAG system.
Use the conversation history plus the latest user message to produce:
- a concise, self-contained search query (refined_query) suitable for retrieval
- an intent label (intent) e.g. "question", "followup", "comparison", "fees", "procedural"
- an output format hint (format) e.g. "paragraph", "table", "steps", "compare_table"

Conversation history:
${lastTurns}

Latest user message:
${userQuery}

Return JSON only: {"refined_query":"...", "intent":"...", "format":"..."}
`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a compact query rewriting assistant for retrieval." },
        { role: "user", content: prompt },
      ],
      max_tokens: 180,
      temperature: 0.0,
    });

    const raw = resp?.choices?.[0]?.message?.content?.trim() || "";
    try {
      const parsed = JSON.parse(raw);
      return {
        refined_query: (parsed.refined_query || parsed.query || userQuery).trim(),
        intent: parsed.intent || parsed.type || "question",
        format: parsed.format || "paragraph",
      };
    } catch (e) {
      // Tolerant fallback
      const lower = userQuery.toLowerCase();
      const intent = /\b(compare|difference|vs\b|versus)\b/.test(lower) ? "comparison" : "question";
      const format = intent === "comparison" ? "compare_table" : "paragraph";
      return { refined_query: userQuery, intent, format };
    }
  } catch (err) {
    // On error, fallback to safe defaults
    return { refined_query: userQuery, intent: "question", format: "paragraph" };
  }
}
