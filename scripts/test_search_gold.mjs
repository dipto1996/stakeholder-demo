/**
 * test_search_gold.mjs
 * Test script for searchGold functionality (ES Module)
 * 
 * Usage:
 *   node scripts/test_search_gold.mjs "Can we hire remote developers from India?"
 */

import { searchGold, formatGoldSources } from '../lib/rag/searchGold.js';

const query = process.argv[2] || "Can we hire a developer in India to work remotely?";

console.log("=".repeat(60));
console.log("Golden Answers Search Test");
console.log("=".repeat(60));
console.log(`\n🔍 Query: "${query}"\n`);

(async () => {
  try {
    const result = await searchGold(query, { limit: 5 });
    
    console.log("📊 Search Results:");
    console.log(`   Found ${result.candidates.length} candidates`);
    console.log(`   Classification: ${result.classification}`);
    console.log(`   Thresholds: high=${result.thresholds.high}, low=${result.thresholds.low}\n`);
    
    if (result.best) {
      console.log("🏆 Best Match:");
      console.log(`   ID: ${result.best.id}`);
      console.log(`   Question: ${result.best.question}`);
      console.log(`   Human Confidence: ${result.best.human_confidence}`);
      console.log(`   Similarity Scores:`);
      console.log(`     - Question: ${result.best.sim_q.toFixed(4)} (dist: ${result.best.dist_q.toFixed(4)})`);
      console.log(`     - Answer: ${result.best.sim_a.toFixed(4)} (dist: ${result.best.dist_a.toFixed(4)})`);
      console.log(`     - Combined: ${result.best.combined.toFixed(4)}`);
      console.log(`\n   Answer Preview:`);
      console.log(`   ${result.best.gold_answer.substring(0, 200)}...\n`);
      
      const formattedSources = formatGoldSources(result.best.sources);
      console.log(`   Sources (${formattedSources.length}):`);
      formattedSources.forEach(src => {
        console.log(`     - ${src.title}: ${src.url}`);
      });
    } else {
      console.log("⚠️  No matches found");
    }
    
    if (result.candidates.length > 1) {
      console.log(`\n📋 Other Candidates:`);
      result.candidates.slice(1, 5).forEach((c, idx) => {
        console.log(`   ${idx + 2}. ${c.id} (score: ${c.combined.toFixed(4)})`);
        console.log(`      ${c.question.substring(0, 80)}...`);
      });
    }
    
    console.log("\n" + "=".repeat(60));
    console.log("✅ Test complete!");
    console.log("=".repeat(60));
    
  } catch (error) {
    console.error("❌ Error:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
})();

