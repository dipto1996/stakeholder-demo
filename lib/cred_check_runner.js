// lib/cred_check_runner.js
/**
 * Credibility Check Runner (Shared Logic)
 * 
 * Validates claims against authoritative sources for the BYPASS_RAG mode.
 * This module contains the core logic extracted from the API route so it can be
 * called directly without HTTP requests (avoiding Vercel auth issues).
 * 
 * Input format:
 * {
 *   answer_text: string,
 *   claims: [{ id: string, text: string }],
 *   citations: [{ claim_id: string, urls: [{ url: string, quoted_snippet: string }] }]
 * }
 * 
 * Output format:
 * {
 *   ok: boolean,
 *   result: {
 *     decision: "verified" | "probable" | "reject",
 *     overall_score: number (0-1),
 *     results: [{ claim_id, score, evidence: [...] }],
 *     summary: { ... }
 *   }
 * }
 */

// Authoritative domain whitelist
const AUTHORITATIVE_DOMAINS = [
  "uscis.gov",
  "state.gov",
  "dol.gov",
  "justice.gov",
  "eoir.justice.gov",
  "ecfr.gov",
  "federalregister.gov",
  "uscourts.gov",
  "courtlistener.com",
  "congress.gov",
  "law.cornell.edu",
  "travel.state.gov",
  "ice.gov",
  "cbp.gov",
];

/**
 * Check if URL is from an authoritative domain
 */
function isAuthoritativeDomain(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return AUTHORITATIVE_DOMAINS.some((domain) => hostname.endsWith(domain));
  } catch {
    return false;
  }
}

/**
 * Score a single claim based on its citations
 */
function scoreClaimCredibility(claim, citations) {
  if (!citations || citations.length === 0) {
    return {
      claim_id: claim.id,
      score: 0,
      evidence: [],
      reason: "No citations provided",
    };
  }

  const evidence = [];
  let totalScore = 0;
  let validCitations = 0;

  for (const citation of citations) {
    for (const urlObj of citation.urls || []) {
      const url = urlObj.url;
      const snippet = urlObj.quoted_snippet || "";

      if (!url) continue;

      const isAuthoritative = isAuthoritativeDomain(url);
      const hasSnippet = snippet && snippet.length > 20;

      // Scoring logic
      let citationScore = 0;
      if (isAuthoritative) {
        citationScore += 0.7; // High base score for authoritative domain
        if (hasSnippet) citationScore += 0.3; // Bonus for quoted evidence
      } else {
        citationScore += 0.3; // Lower base for non-authoritative
        if (hasSnippet) citationScore += 0.2; // Small bonus
      }

      evidence.push({
        url,
        snippet: snippet.slice(0, 200),
        authoritative: isAuthoritative,
        score: citationScore,
      });

      totalScore += citationScore;
      validCitations++;
    }
  }

  // Average score across all citations
  const avgScore = validCitations > 0 ? totalScore / validCitations : 0;

  // Penalize if too few citations
  let finalScore = avgScore;
  if (validCitations === 0) finalScore = 0;
  else if (validCitations === 1) finalScore *= 0.8; // Penalty for single citation
  else if (validCitations >= 3) finalScore = Math.min(1.0, finalScore * 1.1); // Bonus for multiple citations

  return {
    claim_id: claim.id,
    score: Math.max(0, Math.min(1, finalScore)),
    evidence,
    reason:
      validCitations === 0
        ? "No valid citations"
        : `${validCitations} citation(s), ${evidence.filter((e) => e.authoritative).length} authoritative`,
  };
}

/**
 * Main credibility check function
 * @param {Object} gptJson - The structured LLM output with claims and citations
 * @returns {Promise<Object>} - { ok: boolean, result: {...}, error?: string }
 */
export async function runCredCheck(gptJson) {
  try {
    const { answer_text, claims, citations } = gptJson || {};

    // Validate input
    if (!claims || !Array.isArray(claims) || claims.length === 0) {
      return { 
        ok: false, 
        error: "Invalid request: claims array required" 
      };
    }

    if (!citations || !Array.isArray(citations)) {
      return { 
        ok: false, 
        error: "Invalid request: citations array required" 
      };
    }

    // Score each claim
    const results = [];
    for (const claim of claims) {
      // Find citations for this claim
      const claimCitations = citations.filter(
        (c) => c.claim_id === claim.id || c.claimId === claim.id
      );
      const result = scoreClaimCredibility(claim, claimCitations);
      results.push(result);
    }

    // Calculate overall score
    const overallScore =
      results.length > 0
        ? results.reduce((sum, r) => sum + r.score, 0) / results.length
        : 0;

    // Determine decision
    let decision = "reject";
    if (overallScore >= 0.85) decision = "verified";
    else if (overallScore >= 0.6) decision = "probable";

    // Additional heuristics
    const authoritativeCount = results.reduce(
      (sum, r) => sum + r.evidence.filter((e) => e.authoritative).length,
      0
    );
    const totalEvidence = results.reduce(
      (sum, r) => sum + r.evidence.length,
      0
    );

    // Upgrade decision if we have many authoritative sources
    if (
      decision === "probable" &&
      authoritativeCount >= 3 &&
      authoritativeCount / totalEvidence >= 0.7
    ) {
      decision = "verified";
    }

    // Downgrade if too few authoritative sources
    if (decision === "verified" && authoritativeCount < 2) {
      decision = "probable";
    }

    const result = {
      decision,
      overall_score: overallScore,
      results,
      summary: {
        total_claims: claims.length,
        total_citations: totalEvidence,
        authoritative_citations: authoritativeCount,
        answer_text: answer_text?.slice(0, 500) || "",
      },
    };

    return { ok: true, result };
  } catch (err) {
    console.error("runCredCheck error:", err);
    return { 
      ok: false, 
      error: err?.message || "Internal Server Error" 
    };
  }
}

