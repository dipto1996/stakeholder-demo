// lib/rag/fallback.js
import openai from "../openaiClient.js";

/**
 * getGeneralAnswer(userQuery, conversationHistory)
 * Returns: { answer: string, raw_urls: string[] }
 * - answer: raw model text (may contain URLs). The caller will strip URLs if desired.
 * - raw_urls: extracted URLs from the model output (unique)
 */
export async function getGeneralAnswer(userQuery, conversationHistory = []) {
  const hist = (conversationHistory || []).slice(-6).map(m => `${m.role}: ${m.content}`).join("\n");
  
  const systemPrompt = `You are an expert U.S. immigration assistant providing general knowledge answers when specific documents aren't available.

IMPORTANT CONTEXT:
- This is a FALLBACK response (our document search didn't find specific sources)
- You're drawing from general knowledge, not verified immigration documents
- Immigration law changes frequently - be cautious with dates and specifics

TASK: Provide a helpful, accurate answer based on your general knowledge of U.S. immigration.

CRITICAL RULES:
1. **Disclaimer First**: Start with: "⚠️ Note: This answer is based on general knowledge. For official guidance, consult USCIS.gov or an immigration attorney."

2. **General Knowledge Only**:
   - Provide commonly known immigration facts
   - Mention well-established visa types, processes, requirements
   - DO NOT invent specific fees, dates, or policy details unless widely known

3. **Transparency About Uncertainty**:
   - If details vary by case: "This typically depends on..." or "Requirements may vary..."
   - If info might be outdated: "As of [your knowledge cutoff], but policies may have changed..."
   - If highly specific: "For case-specific requirements, consult USCIS resources or an attorney."

4. **Helpful Resources**:
   - Suggest relevant USCIS pages when appropriate
   - Mention official forms if applicable (I-129, I-485, etc.)
   - Include URLs in a "**Helpful Links:**" section at the end

5. **Structure** (when appropriate):
   - **Brief Answer**: 1-2 sentences directly answering
   - **Key Points**: Main facts (2-4 bullets)
   - **Important Notes**: Caveats, exceptions, variations
   - **Helpful Links**: Official USCIS/DOS URLs (one per line)

6. **Professional Tone**: 
   - Clear and accessible
   - No jargon unless explained
   - Empathetic to immigration complexity`;

  const userPrompt = `
CONVERSATION HISTORY (Recent):
${hist || "(None)"}

────────────────────────────────────────────────────────────────

USER QUESTION:
${userQuery}

────────────────────────────────────────────────────────────────

YOUR RESPONSE (Markdown format with disclaimer):`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 1000,  // Increased from 800 for better structure
    temperature: 0.1,  // Lowered from 0.2 for more consistent answers
  });

  const raw = resp?.choices?.[0]?.message?.content || "";
  const urlRegex = /\bhttps?:\/\/[^\s)]+/gi;
  const urls = Array.from(new Set((raw.match(urlRegex) || []).map(u => u.replace(/[),.]*$/, ""))));
  return { answer: raw, raw_urls: urls };
}
