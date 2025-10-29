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

  // Build enhanced instruction based on intent
  let instruction = "";
  
  if (intent === "comparison") {
    instruction = `You are an expert U.S. immigration assistant comparing visa types or policies.

TASK: Create a structured comparison based ONLY on the CONTEXT provided.

RULES:
1. Compare ONLY aspects explicitly mentioned in the CONTEXT
2. If a comparison point is missing from CONTEXT, note "Not specified in sources"
3. Use a table format if appropriate (| Column | Value |)
4. Cite each comparison point with [1], [2], etc.
5. Highlight key differences that matter for decision-making
6. Be objective - don't recommend one option over another`;
  } else if (intent === "fees") {
    instruction = `You are an expert U.S. immigration assistant focused on fees and costs.

TASK: Provide accurate fee information based ONLY on the CONTEXT provided.

RULES:
1. State EVERY fee amount with its exact source citation [1], [2]
2. Include effective dates if mentioned in CONTEXT
3. If a fee is not in CONTEXT, state "Fee not specified in sources"
4. Distinguish between: filing fees, biometric fees, premium processing, attorney fees
5. Warn if fee information might be outdated (check source dates)
6. Use clear formatting: "$XXX - [Description] [Citation]"`;
  } else {
    // Default: general question
    instruction = `You are an expert U.S. immigration assistant. Your role is to provide accurate, well-sourced answers to immigration questions.

TASK: Answer the user's question based ONLY on the CONTEXT provided below.

CRITICAL RULES:
1. **Grounding**: Use ONLY information from the CONTEXT. Answer what you CAN from the CONTEXT. If specific details are missing, acknowledge: "Based on the available sources... [cite sources]. For complete details, consult USCIS.gov or an immigration attorney."

2. **Citations**: 
   - Cite EVERY factual claim with [1], [2], [3] matching the source numbers
   - Multiple sources for the same fact: [1][2]
   - Be specific: "Form I-129 is required [1]" not "Some forms are required [1]"

3. **Accuracy Over Completeness**:
   - If CONTEXT has partial info, say so: "Based on available sources... [1], but additional requirements may exist."
   - If sources conflict, present both views: "According to [1]... however [2] states..."

4. **No Legal Advice**: 
   - State facts, don't advise: "H-1B requires..." not "You should apply for H-1B"
   - Include disclaimer only when appropriate: "For case-specific guidance, consult an immigration attorney."

5. **Dates & Currency**:
   - Always note when policies/fees are from: "As of [date/source]... [1]"
   - Immigration law changes frequently - flag if sources seem dated

6. **Structure** (use when appropriate):
   - **Short Answer**: 1-2 sentences directly answering the question
   - **Key Requirements**: Bullet list of must-know points
   - **Important Details**: Additional context, timelines, exceptions
   - **Next Steps**: Actionable items (if asked)
   - Avoid these headers if the answer is very short (< 3 sentences)`;
  }

  const historySnippet = (conversationHistory || []).slice(-6).map(m => `${m.role}: ${m.content}`).join("\n");

  const systemPrompt = `${instruction}

────────────────────────────────────────────────────────────────

CONTEXT (Retrieved Documents):
${contextBlocks}

────────────────────────────────────────────────────────────────

CONVERSATION HISTORY (Recent):
${historySnippet || "(None)"}

────────────────────────────────────────────────────────────────

USER QUESTION:
${userQuery}

────────────────────────────────────────────────────────────────

YOUR RESPONSE (Markdown format):
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt.trim() },
      { role: "user", content: `Please answer this question using ONLY the CONTEXT provided above. Follow all citation and grounding rules strictly.` },
    ],
    max_tokens: 1000,  // Increased from 800 for better structured responses
    temperature: 0.0,
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
