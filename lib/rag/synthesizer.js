// lib/rag/synthesizer.js
import openai from "../openaiClient.js";

/**
 * synthesizeRAGAnswer(topDocs, userQuery, intent, conversationHistory)
 * - topDocs: [{ id, content, source_title, source_url, score }]
 * - conversationHistory: previous messages (array)
 * Returns: { answer: string, sources: Array<{id,title,url,excerpt}> }
 */
export async function synthesizeRAGAnswer(topDocs = [], userQuery, intent = "question", conversationHistory = []) {
  const contextBlocks = topDocs.map((d, i) => {
    const title = d.source_title || d.source_file || `source ${i + 1}`;
    const excerpt = (d.content || "").slice(0, 1600).replace(/\n{3,}/g, "\n\n");
    return `[${i + 1}] title: ${title}\nurl: ${d.source_url || ""}\ncontent: ${excerpt}`;
  }).join("\n\n---\n\n");

  let instruction = `You are a precise assistant for U.S. immigration. Use ONLY the CONTEXT below to answer the user's question. If the answer is not supported by the CONTEXT, say "Not in sources." Be concise and factual. Cite facts with bracketed numbers [1], [2] that correspond to the listed sources. Avoid legal advice.`;

  if (intent === "comparison") instruction = `Create a concise comparison. Use a table if the user requested "table". Use only the CONTEXT and cite sources with [1],[2].`;
  if (intent === "fees") instruction = `Focus on fee numbers and dates. Verify numeric claims against context; if you cannot verify a numeric claim, say "Not in sources."`;

  const historySnippet = (conversationHistory || []).slice(-6).map(m => `${m.role}: ${m.content}`).join("\n");

  const systemPrompt = `
${instruction}

CONTEXT:
${contextBlocks}

Conversation history (recent):
${historySnippet}

QUESTION:
${userQuery}

OUTPUT (markdown only):
Prefer these sections when appropriate:
**Answer:** (short)
**Key Points:** (3 bullets)
**Next Steps:** (up to 3 bullets)
**Sources:** (list references like [1], [2])
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini", // Changed from gpt-4o for faster response (3-5x faster)
    messages: [
      { role: "system", content: systemPrompt.trim() },
      { role: "user", content: `Answer concisely based ONLY on the CONTEXT. User question: ${userQuery}` },
    ],
    max_tokens: 600, // Reduced from 800 for faster generation
    temperature: 0.0,
  });

  const ans = completion?.choices?.[0]?.message?.content?.trim() || "";

  const sources = topDocs.map((d, i) => ({
    id: i + 1,
    title: d.source_title || d.source_file || `Source ${i + 1}`,
    url: d.source_url || null,
    excerpt: (d.content || "").slice(0, 600),
  }));

  return { answer: ans, sources };
}
