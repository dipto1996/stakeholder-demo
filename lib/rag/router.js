// lib/rag/router.js
import openai from "../openaiClient.js";

/**
 * routeQuery(userQuery, conversationHistory)
 * Returns: { refined_query, intent, format }
 *
 * Important: conversationHistory is an array of previous messages:
 * [{role:'user'|'assistant', content: '...'}, ...]
 */
export async function routeQuery(userQuery, conversationHistory = []) {
  // Build a short context that includes last 4 turns (trim tokens)
  const lastTurns = (conversationHistory || []).slice(-6).map(m => `${m.role}: ${m.content}`).join("\n");
  const prompt = `
You are a fast, focused query rewritter for an immigration RAG system.
Given the user's latest message and the short conversation history, create:
1) a concise, self-contained search query suitable for retrieval (single line).
2) an intent label (one word) such as "question", "followup", "comparison", "procedural", "fees".
3) a suggested output format token such as "paragraph", "table", "steps", "compare_table".

Conversation history:
${lastTurns}

Latest user message:
${userQuery}

Produce JSON only with keys: refined_query, intent, format
Example:
{"refined_query":"H-1B visa application fees 2025","intent":"fees","format":"table"}
`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a compact query rewriting assistant." },
      { role: "user", content: prompt },
    ],
    max_tokens: 200,
    temperature: 0.0,
  });

  const raw = resp?.choices?.[0]?.message?.content?.trim() || "";
  // tolerant JSON parse
  try {
    const parsed = JSON.parse(raw);
    return {
      refined_query: (parsed.refined_query || parsed.query || userQuery).trim(),
      intent: parsed.intent || parsed.type || "question",
      format: parsed.format || "paragraph",
    };
  } catch (e) {
    // fallback: simple heuristic
    const lower = userQuery.toLowerCase();
    const intent = /\b(compare|difference|vs\b|versus)\b/.test(lower) ? "comparison" : "question";
    const format = intent === "comparison" ? "compare_table" : "paragraph";
    return { refined_query: userQuery, intent, format };
  }
}
