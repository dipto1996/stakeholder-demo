// lib/rag/synthesizer.js
import openai from "../openaiClient.js";

/**
 * synthesizeRAGAnswer(rankedDocs, userQuery, intent, conversationHistory)
 * returns { answer, sources }
 *
 * NOTE: This prompt instructs the model to include the exact phrase "Not in sources" when something is missing.
 */
export async function synthesizeRAGAnswer(rankedDocs = [], userQuery, intent = "question", conversationHistory = []) {
  const docBlock = rankedDocs
    .map((d, i) => `[${i + 1}] Title: ${d.source_title || d.source_file || `Doc ${d.id}`}\nURL: ${d.source_url || "N/A"}\nExcerpt:\n${(d.content || "").slice(0, 1200)}\n`)
    .join("\n---\n");

  const formatInstruction = {
    table: "Produce a comparison table and include inline [n] citations.",
    short_answer: "Give a concise answer (2–4 sentences) with citations.",
    bullet_points: "Return 3–5 concise bullets with citations.",
    step_by_step: "Return clear numbered steps. Cite sources for factual steps.",
  }[intent] || "Give a concise, factual answer with inline citations.";

  const history = (conversationHistory || []).slice(-6).map((m) => `${m.role || m.sender}: ${m.content}`).join("\n");

  const systemPrompt = `
You are a careful assistant. Use ONLY the documents below to answer; cite facts inline with [n] referencing the document order.
If a fact is not present, say EXACTLY: "Not in sources" for that part (use these words).
Do not invent facts or external URLs. If the documents do not fully answer the user's question, indicate which parts are "Not in sources".
Return a markdown answer with sections such as headings, bullets or numbered lists as appropriate.
End with two suggested follow-up questions the user may want.
`;

  const userPrompt = `
CONTEXT:
${docBlock}

QUESTION:
${userQuery}

RECENT_HISTORY:
${history}
`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.0,
      max_tokens: 1000,
    });

    const raw = resp?.choices?.[0]?.message?.content || "";
    const sources = rankedDocs.map((d, i) => ({
      id: i + 1,
      title: d.source_title || d.source_file || `Doc ${d.id}`,
      url: d.source_url || null,
      excerpt: (d.content || "").slice(0, 400),
      score: d.score || 0,
    }));

    return { answer: raw.trim(), sources };
  } catch (err) {
    console.warn("synthesizeRAGAnswer error:", err?.message || err);
    const fallbackText = "Sorry — I couldn't synthesize a reliable RAG answer from the sources.";
    const sources = rankedDocs.map((d, i) => ({ id: i + 1, title: d.source_title || d.source_file || `Doc ${d.id}`, url: d.source_url || null }));
    return { answer: fallbackText, sources };
  }
}
