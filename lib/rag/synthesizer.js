// lib/rag/synthesizer.js
import openai from "../openaiClient.js";
import { extractAndValidateClaims } from "../claim_extractor.js";

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

  let instruction = `You are an expert U.S. immigration assistant. Answer the question using the CONTEXT below.

Rules:
- Synthesize all relevant information from the CONTEXT
- Cite every fact: [1], [2], [3]
- Be thorough but concise
- State requirements clearly - no personal advice`;

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
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt.trim() },
      { role: "user", content: `Answer concisely based ONLY on the CONTEXT. User question: ${userQuery}` },
    ],
    max_tokens: 800,
    temperature: 0.1,
  });

  const ans = completion?.choices?.[0]?.message?.content?.trim() || "";

  const sources = topDocs.map((d, i) => ({
    id: i + 1,
    title: d.source_title || d.source_file || `Source ${i + 1}`,
    url: d.source_url || null,
    excerpt: (d.content || "").slice(0, 600),
  }));

  // Phase 2: Extract claims from synthesized answer
  // This enables claim-level evaluation and hallucination detection
  let claims = [];
  try {
    // Check if claim extraction is enabled (default: true, can disable with env var)
    const enableClaimExtraction = process.env.ENABLE_CLAIM_EXTRACTION !== "0";
    
    if (enableClaimExtraction && ans) {
      console.log("[synthesizer] Extracting claims from answer...");
      claims = await extractAndValidateClaims(ans, topDocs, { maxClaims: 10 });
      console.log(`[synthesizer] Extracted ${claims.length} claims (${claims.filter(c => c.verified).length} verified)`);
    }
  } catch (claimError) {
    console.warn("[synthesizer] Claim extraction failed:", claimError?.message || claimError);
    // Continue without claims rather than failing
    claims = [];
  }

  return { answer: ans, sources, claims };
}
