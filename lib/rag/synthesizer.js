// lib/rag/synthesizer.js
import openai from "../openaiClient.js";

/**
 * synthesizeRAGAnswer(topDocs, userQuery, intent, conversationHistory)
 * topDocs: [{ id, content, source_title, source_url, score }]
 * conversationHistory: array of previous messages (so the model can consider earlier context)
 *
 * Returns { answer: string (markdown), sources: Array<{id,title,url}> }
 */
export async function synthesizeRAGAnswer(topDocs = [], userQuery, intent = "question", conversationHistory = []) {
  // Build context block annotated with numbered sources
  const contextBlocks = topDocs.map((d, i) => {
    const title = d.source_title || d.source_file || `source ${i + 1}`;
    const excerpt = (d.content || "").slice(0, 1600).replace(/\n{3,}/g, "\n\n");
    return `[${i + 1}] title: ${title}\nurl: ${d.source_url || ""}\ncontent: ${excerpt}`;
  }).join("\n\n---\n\n");

  // dynamic instruction based on intent/format
  let instruction = `You are a precise assistant for U.S. immigration topics. Use ONLY the CONTEXT below to answer. If the answer is missing from the context, say "Not in sources." Be brief and factual. Cite with [1], [2] corresponding to the sources above.`;
  if (intent === "comparison") instruction = `Create a concise comparison. Use a table if the user asked for a table. Use the CONTEXT only and cite sources.`;
  if (intent === "fees") instruction = `Focus on fee numbers and dates; verify numeric claims against context. If you cannot verify a number, say "Not in sources."`;

  // Include condensed conversation history (last few turns) so the model can adapt tone/clarify follow-ups
  const historySnippet = (conversationHistory || []).slice(-6).map(m => `${m.role}: ${m.content}`).join("\n");

  const systemPrompt = `
${instruction}

CONTEXT:
${contextBlocks}

Conversation history:
${historySnippet}

QUESTION:
${userQuery}

OUTPUT FORMAT:
Return ONLY markdown. If possible include these sections (format flexibly based on intent):
**Answer:** (short)
**Key Points:** (3 bullets)
**Sources:** list [1], [2]
`;

  // Call LLM
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt.trim() },
      { role: "user", content: `Answer concisely based on CONTEXT. User question: ${userQuery}` },
    ],
    max_tokens: 700,
    temperature: 0.0,
  });

  const ans = completion?.choices?.[0]?.message?.content?.trim() || "";

  // Build sources for frontend mapping
  const sources = topDocs.map((d, i) => ({
    id: i + 1,
    title: d.source_title || d.source_file || `Source ${i + 1}`,
    url: d.source_url || null,
    excerpt: (d.content || "").slice(0, 600),
  }));

  return { answer: ans, sources };
}
