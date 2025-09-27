// lib/rag/router.js
import openai from "../openaiClient.js";

/**
 * routeQuery(userQuery, conversationHistory)
 * returns { refined_query, intent, format }
 */
export async function routeQuery(userQuery, conversationHistory = []) {
  const historySnippet = (conversationHistory || [])
    .slice(-6)
    .map((m) => `${m.role || m.sender}: ${m.content}`)
    .join("\n");

  const prompt = `
You are a lightweight "Router" assistant. For the given user query and recent conversation context:
1) Produce a concise, search-optimized refined_query (one line).
2) Choose a single intent label from: question, follow_up, comparison, explain, procedural, greet.
3) Choose an output format from: short_answer, bullet_points, table, step_by_step.

Return ONLY JSON: { "refined_query":"...", "intent":"...", "format":"..." }.

User query:
"""${userQuery}"""

Context:
${historySnippet}
`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 180,
      temperature: 0.0,
    });

    const raw = resp?.choices?.[0]?.message?.content?.trim() || "";
    try {
      const idx = raw.indexOf("{");
      const jsonText = idx >= 0 ? raw.slice(idx) : raw;
      const parsed = JSON.parse(jsonText);
      return {
        refined_query: parsed.refined_query || userQuery,
        intent: parsed.intent || "question",
        format: parsed.format || "short_answer",
      };
    } catch {
      return { refined_query: userQuery, intent: "question", format: "short_answer" };
    }
  } catch {
    return { refined_query: userQuery, intent: "question", format: "short_answer" };
  }
}
