// lib/rag/reranker.js
import openai from "../openaiClient.js";

/**
 * rerankCandidates(refinedQuery, candidates, topK)
 * candidates: [{ id, content, source_title, source_url, source_file }]
 * returns topK candidates with .score (0..1)
 */
export async function rerankCandidates(refinedQuery, candidates = [], topK = 5) {
  if (!candidates || candidates.length === 0) return [];

  const docsText = candidates
    .map((d, i) => `DOC_${i + 1} | id:${d.id}\nExcerpt:\n${(d.content || "").slice(0, 400)}\n`)
    .join("\n---\n");

  const prompt = `
You are a relevance scorer. Given the query and short document excerpts, return a JSON array:
[{"id":"<doc id>", "score": <0..1>}, ...] with 1 = highly relevant.

Query:
"""${refinedQuery}"""

Documents:
${docsText}

Return only JSON.
`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 400,
      temperature: 0.0,
    });

    const raw = resp?.choices?.[0]?.message?.content || "";
    try {
      const idx = raw.indexOf("[");
      const jsonText = idx >= 0 ? raw.slice(idx) : raw;
      const parsed = JSON.parse(jsonText);
      const scored = candidates.map((c) => {
        const p = parsed.find((x) => String(x.id) === String(c.id));
        return { ...c, score: p ? Number(p.score) : 0 };
      });
      return scored.sort((a, b) => b.score - a.score).slice(0, topK);
    } catch {
      // fallback lexical heuristic
      const lowerQ = refinedQuery.toLowerCase();
      const scored = candidates.map((c) => {
        const overlap = (c.content || "").toLowerCase().split(/\W+/).filter((t) => t && lowerQ.includes(t)).length;
        return { ...c, score: Math.min(1, overlap / 8) };
      });
      return scored.sort((a, b) => b.score - a.score).slice(0, topK);
    }
  } catch (err) {
    console.warn("rerankCandidates error:", err?.message || err);
    return candidates.slice(0, topK);
  }
}
