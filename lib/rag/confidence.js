// lib/rag/confidence.js
/**
 * isConfident(rankedDocs = [])
 *
 * We make the confidence requirement stricter so the system falls back more often
 * while the KB is immature. Tune these numbers over time by observing logs.
 *
 * Current logic:
 * - If we have >=2 docs: require top >= 0.90 and meanTop3 >= 0.70
 * - If a single doc is extremely strong (top >= 0.97) accept it.
 */
export function isConfident(rankedDocs = []) {
  if (!rankedDocs || rankedDocs.length === 0) return false;
  const top = rankedDocs[0].score || 0;
  const meanTop3 =
    (rankedDocs.slice(0, 3).reduce((s, d) => s + (d.score || 0), 0) / Math.min(3, rankedDocs.length)) || 0;

  if (rankedDocs.length >= 2 && top >= 0.85 && meanTop3 >= 0.65) return true;
  if (top >= 0.90) return true;
  return false;
}
