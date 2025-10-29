// lib/claim_extractor.js
/**
 * Claim Extraction Module
 * 
 * Extracts atomic factual claims from RAG-synthesized answers and links each
 * claim to its supporting source document.
 * 
 * This enables:
 * - Granular claim-level evaluation
 * - Hallucination detection (claims without sources)
 * - Source attribution (which doc supports which claim)
 * - Critical claim tracking
 */

import openai from "./openaiClient.js";

/**
 * Extract claims from a synthesized answer
 * @param {string} answer - The synthesized answer text
 * @param {Array} documents - Retrieved documents used for synthesis
 * @param {Object} options - Extraction options
 * @returns {Promise<Array>} - Array of claim objects
 */
export async function extractClaims(answer, documents, options = {}) {
  const {
    maxClaims = 10,
    minClaimLength = 20,
  } = options;

  if (!answer || !answer.trim()) {
    return [];
  }

  // Prepare document context for the LLM
  const docContext = documents.map((doc, idx) => ({
    doc_id: `doc_${idx}`,
    title: doc.source_title || doc.title || `Document ${idx + 1}`,
    url: doc.source_url || doc.url || null,
    excerpt: (doc.content || "").slice(0, 800), // Limit per doc
  }));

  const systemPrompt = `You are a claim extraction specialist for immigration law Q&A.

TASK: Extract atomic factual claims from the answer and link each claim to its source document.

RULES:
1. Each claim must be a single, verifiable fact
2. Claims should be self-contained (understandable without context)
3. Extract only factual claims (not opinions, advice, or disclaimers)
4. Link each claim to the specific document that supports it
5. If a claim isn't supported by any document, mark verified: false
6. Prioritize claims about: requirements, fees, timelines, eligibility, documents

OUTPUT FORMAT (JSON):
{
  "claims": [
    {
      "id": "c1",
      "text": "Atomic factual claim here",
      "doc_id": "doc_0",  // or null if not found in documents
      "verified": true,   // false if no document supports this claim
      "critical": false   // true for must-have facts (requirements, eligibility)
    }
  ]
}

EXAMPLES OF GOOD CLAIMS:
- "H-1B requires a bachelor's degree or equivalent"
- "Form I-129 filing fee is $460"
- "L-1A allows managers to work for up to 7 years"

EXAMPLES OF BAD CLAIMS (don't extract):
- "You should consult an attorney" (advice)
- "This information may be outdated" (disclaimer)
- "Immigration is complex" (opinion)`;

  const userPrompt = `ANSWER TO ANALYZE:
${answer}

SUPPORTING DOCUMENTS:
${docContext.map((doc) => `
[${doc.doc_id}]
Title: ${doc.title}
URL: ${doc.url || "N/A"}
Content: ${doc.excerpt}
`).join('\n---\n')}

Extract all factual claims from the answer and link each to its source document.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.0,
      max_tokens: 1500,
    });

    const raw = response?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    const extractedClaims = parsed.claims || [];

    // Post-process claims
    const processedClaims = extractedClaims
      .filter(claim => claim.text && claim.text.length >= minClaimLength)
      .slice(0, maxClaims)
      .map((claim, idx) => {
        // Find the actual document reference
        const docMatch = docContext.find(d => d.doc_id === claim.doc_id);
        
        return {
          id: claim.id || `c${idx + 1}`,
          text: claim.text.trim(),
          source: docMatch ? {
            title: docMatch.title,
            url: docMatch.url,
            snippet: claim.snippet || docMatch.excerpt.slice(0, 200)
          } : null,
          verified: claim.verified !== false && docMatch !== undefined,
          critical: claim.critical || false,
        };
      });

    console.log(`[claim_extractor] Extracted ${processedClaims.length} claims from answer`);
    return processedClaims;

  } catch (error) {
    console.error("[claim_extractor] Error extracting claims:", error?.message || error);
    // Fallback: return empty array rather than failing
    return [];
  }
}

/**
 * Validate claims against documents (additional verification layer)
 * @param {Array} claims - Claims to validate
 * @param {Array} documents - Source documents
 * @returns {Array} - Claims with updated verification status
 */
export function validateClaims(claims, documents) {
  return claims.map(claim => {
    if (!claim.source) {
      // Already marked as unverified
      return claim;
    }

    // Check if claim text appears in source document
    const sourceDoc = documents.find(
      d => d.source_title === claim.source.title || d.source_url === claim.source.url
    );

    if (!sourceDoc) {
      return { ...claim, verified: false };
    }

    // Simple text overlap check
    const claimTokens = claim.text.toLowerCase().split(/\s+/).filter(t => t.length > 3);
    const docText = (sourceDoc.content || "").toLowerCase();
    const matchCount = claimTokens.filter(token => docText.includes(token)).length;
    const matchRatio = matchCount / claimTokens.length;

    // If less than 50% of claim tokens appear in source, mark as unverified
    if (matchRatio < 0.5) {
      return { ...claim, verified: false };
    }

    return claim;
  });
}

/**
 * Extract claims with validation
 * @param {string} answer - Synthesized answer
 * @param {Array} documents - Source documents
 * @param {Object} options - Options
 * @returns {Promise<Array>} - Validated claims
 */
export async function extractAndValidateClaims(answer, documents, options = {}) {
  const claims = await extractClaims(answer, documents, options);
  return validateClaims(claims, documents);
}

