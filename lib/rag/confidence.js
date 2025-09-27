// lib/rag/confidence.js
/**
 * isConfident(rankedDocs = [])
 *
 * Balanced thresholds:
 * - If we have >=2 docs: require top >= 0.72 and meanTop3 >= 0.48
 * - Or if single doc is extremely strong (top >= 0.92) accept
 */
export function isConfident(rankedDocs = []) {
  if (!rankedDocs || rankedDocs.length === 0) return false;
  const top = rankedDocs[0].score || 0;
  const meanTop3 =
    (rankedDocs.slice(0, 3).reduce((s, d) => s + (d.score || 0), 0) / Math.min(3, rankedDocs.length)) || 0;

  if (rankedDocs.length >= 2 && top >= 0.72 && meanTop3 >= 0.48) return true;
  if (top >= 0.92) return true;
  return false;
}
