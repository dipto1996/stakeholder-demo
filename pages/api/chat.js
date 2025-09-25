// pages/api/chat.js
import OpenAI from "openai";
import { sql } from "@vercel/postgres";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages required" });
    }

    const userQuery = (messages[messages.length - 1].content || "").trim();
    if (!userQuery) return res.status(400).json({ error: "empty user query" });

    // Quick greeting shortcut (cheap)
    const GREETING_RE = /^(hi|hello|hey|good morning|good afternoon|good evening)\b/i;
    if (GREETING_RE.test(userQuery)) {
      return res.status(200).json({
        answer: "Hello! 👋 I can help explain U.S. immigration rules (H-1B, F-1, OPT, CPT). What would you like to know?",
        sources: []
      });
    }

    // 1) Create embedding for query
    const embResp = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: userQuery,
    });
    const queryEmbedding = embResp?.data?.[0]?.embedding;
    if (!queryEmbedding) throw new Error("Embedding failed");

    const embLiteral = JSON.stringify(queryEmbedding);

    // 2) Retrieve top documents (assumes documents table has source_title, source_url, content, embedding)
    const q = await sql`
      SELECT source_title, source_url, content
      FROM documents
      ORDER BY embedding <=> ${embLiteral}::vector
      LIMIT 5
    `;
    const rows = q?.rows ?? [];

    // If no docs found, return helpful fallback (no LLM cost)
    if (!rows.length) {
      return res.status(200).json({
        answer: "I couldn't find supporting documents in our indexed sources for that question. Would you like me to answer more generally or run a broader search?",
        sources: []
      });
    }

    // 3) Build a trimmed context for the model
    const MAX_EXCERPT = 1200;
    const MAX_CONTEXT_TOTAL = 4000;
    let total = 0;
    const parts = [];
    const sources = [];
    for (let i = 0; i < rows.length; i++) {
      const title = rows[i].source_title || `Source ${i + 1}`;
      const url = rows[i].source_url || null;
      const excerpt = (rows[i].content || "").slice(0, MAX_EXCERPT);
      if (total + excerpt.length > MAX_CONTEXT_TOTAL) break;
      total += excerpt.length;
      parts.push(`[${i + 1}] ${title}\n${excerpt}`);
      sources.push({ id: i + 1, title, url });
    }
    const contextText = parts.join("\n\n---\n\n");

    // 4) Ask LLM (non-streaming)
    const systemPrompt = `You are a friendly and accurate assistant for U.S. immigration questions.
Only use the CONTEXT below for factual claims. Cite sources inline with [1], [2], etc.
If context is insufficient, say you cannot find the answer in the provided documents. Do NOT give legal advice.
Structure response: short direct answer, key points (bullets), next steps.`;
    const userPrompt = `CONTEXT:
${contextText}

QUESTION:
${userQuery}`;

    // robust extraction for different SDK shapes
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.15,
      max_tokens: 800,
    });

    // Extract text responsibly (supports several SDK response shapes)
    let answerText = "";
    if (completion?.choices?.[0]?.message?.content) {
      answerText = completion.choices[0].message.content;
    } else if (completion?.output?.[0]?.content?.[0]?.text) {
      answerText = completion.output[0].content[0].text;
    } else if (typeof completion === "string") {
      answerText = completion;
    } else {
      // last resort: stringify entire response (for debugging)
      answerText = JSON.stringify(completion);
    }

    // 5) Return JSON with answer & structured sources
    return res.status(200).json({
      answer: answerText,
      sources
    });

  } catch (err) {
    console.error("API error:", err);
    return res.status(500).json({ error: err.message || "Internal Server Error" });
  }
}
