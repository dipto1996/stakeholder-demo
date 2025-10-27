// pages/api/cred_check.js
/**
 * Credibility Checker API
 * 
 * Validates claims against authoritative sources for the BYPASS_RAG mode.
 * This endpoint is a thin wrapper around the shared runCredCheck logic.
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
 *     results: [{ claim_id, score, evidence: [...] }]
 *   }
 * }
 */

import { runCredCheck } from "../../lib/cred_check_runner.js";

export const config = { runtime: "nodejs" };

/**
 * API Handler - delegates to shared runner
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const result = await runCredCheck(req.body || {});
    
    if (!result.ok) {
      return res.status(400).json({ error: result.error || "Invalid request" });
    }
    
    return res.status(200).json(result);
  } catch (err) {
    console.error("cred_check api error:", err);
    return res.status(500).json({ 
      ok: false, 
      error: err?.message || "Internal Server Error" 
    });
  }
}
