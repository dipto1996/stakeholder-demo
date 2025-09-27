// lib/rag/reranker.js
import openai from "../openaiClient.js";
import { TRUSTED_DOMAINS, NEWS_DOMAINS } from "./retriever.js";

/**
 * Helper: domain based boost/penalty factor
 */
function domainFactor(url = "") {
  if (!url) return 1.0;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (TRUSTED_DOMAINS.some(d => host.endsWith(d))) return 1.25; // boost trusted
    if (NEWS_DOMAINS.some(d => host.endsWith(d))) return 0.85; // penalize common news sources
    // small boost for gov or .gov domain
    if (host.endsWith(".gov")) return 1.2;
    return 1.0;
  } catch (e) {
    return 1.0;
  }
}

/**
 * rerankCandidates(refinedQuery, candidates, topK)
 * returns topK candidates with .score (0..1)
 */
export async function rerankCandidates(refinedQuery, candidates = [], topK = 5) {
  if (!candidates || candidates.length === 0) return [];

  const docsText = candidates
    .map((d, i) => `DOC_${i + 1} | id:${d.id}\nURL:${d.source_url || "N/A"}\nExcerpt:\n${(d.content || "").slice(0, 400)}\n`)
    .join("\n---\n");

  const prompt = `
You are a relevance scorer. Given a query and a short document excerpt, return JSON array:
[{"id":"<doc id>", "score": <0..1>}, ...]. Higher score = more relevant.

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
        const baseScore = p ? Math.max(0, Math.min(1, Number(p.score))) : 0;
        const factor = domainFactor(c.source_url);
        // apply factor and clamp
        let adjusted = baseScore * factor;
        if (adjusted > 1) adjusted = 1;
        if (adjusted < 0) adjusted = 0;
        return { ...c, score: adjusted };
      });

      return scored.sort((a,b)=>b.score - a.score).slice(0, topK);
    } catch (e) {
      // fallback lexical heuristic + domain factor
      const lowerQ = refinedQuery.toLowerCase();
      const scored = candidates.map((c) => {
        const overlap = (c.content || "").toLowerCase().split(/\W+/).filter(t => t && lowerQ.includes(t)).length;
        const base = Math.min(1, overlap / 8);
        const factor = domainFactor(c.source_url);
        let adjusted = base * factor;
        if (adjusted > 1) adjusted = 1;
        return { ...c, score: adjusted };
      });
      return scored.sort((a,b)=>b.score - a.score).slice(0, topK);
    }
  } catch (err) {
    console.warn("rerankCandidates error:", err?.message || err);
    // final fallback: lexical + domain
    const lowerQ = refinedQuery.toLowerCase();
    const scored = candidates.map((c) => {
      const overlap = (c.content || "").toLowerCase().split(/\W+/).filter(t => t && lowerQ.includes(t)).length;
      const base = Math.min(1, overlap / 8);
      const factor = domainFactor(c.source_url);
      let adjusted = base * factor;
      if (adjusted > 1) adjusted = 1;
      return { ...c, score: adjusted };
    });
    return scored.sort((a,b)=>b.score - a.score).slice(0, topK);
  }
}
