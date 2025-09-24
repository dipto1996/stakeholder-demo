// chat.js — Edge-ready RAG chat handler (Vercel Edge + @vercel/postgres + OpenAI)
// IMPORTANT: No binary preamble. Model output only (so ai/react streaming parser works).

import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

export const config = { runtime: 'edge' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Tunables
const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const VECTOR_DIMENSION = 1536;
const MAX_EXCERPT = 1600;   // per-source chars
const MAX_CONTEXT_TOTAL = 6000; // total chars across all excerpts
const EMB_RETRIES = 3;
const CHAT_RETRIES = 2;

async function createEmbeddingsWithRetry(input) {
  for (let attempt = 0; attempt < EMB_RETRIES; attempt++) {
    try {
      return await openai.embeddings.create({ model: EMBEDDING_MODEL, input });
    } catch (e) {
      if (attempt === EMB_RETRIES - 1) throw e;
      await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
    }
  }
}

async function createCompletionWithRetry(messages, stream = true) {
  for (let attempt = 0; attempt < CHAT_RETRIES; attempt++) {
    try {
      return await openai.chat.completions.create({
        model: CHAT_MODEL,
        stream,
        messages,
        temperature: 0.15,
      });
    } catch (e) {
      if (attempt === CHAT_RETRIES - 1) throw e;
      await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
    }
  }
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const body = await req.json();
    const { messages } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response('Invalid request body', { status: 400 });
    }
    const userQuery = (messages[messages.length - 1].content || '').trim();
    if (!userQuery) return new Response('Empty user query', { status: 400 });

    // Quick greeting shortcut (cheap & fast)
    const GREETING_RE = /^(hi|hello|hey|good morning|good afternoon|good evening)\b/i;
    if (GREETING_RE.test(userQuery)) {
      const greeting = "Hello! 👋 I can help explain U.S. immigration rules (H-1B, F-1, OPT, CPT). What would you like to know?";
      const s = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(greeting));
          controller.close();
        }
      });
      return new StreamingTextResponse(s);
    }

    // 1) Get query embedding (retryable)
    const embResp = await createEmbeddingsWithRetry(userQuery);
    if (!embResp?.data?.[0]?.embedding) throw new Error('Embedding API returned no embedding');
    const queryEmbedding = embResp.data[0].embedding;
    const embLiteral = JSON.stringify(queryEmbedding);

    // 2) Retrieve top-k using @vercel/postgres sql (cast to ::vector)
    const q = await sql`
      SELECT content, source_file
      FROM documents
      ORDER BY embedding <=> ${embLiteral}::vector
      LIMIT 6
    `;
    const rows = q?.rows ?? [];

    // 3) If nothing found — friendly fallback (no LLM call)
    if (!rows || rows.length === 0) {
      const fallback = "I couldn't find supporting documents in our indexed sources for that question. Would you like (A) broader search, (B) general guidance, or (C) lawyer review?";
      const s = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(fallback));
          controller.close();
        }
      });
      return new StreamingTextResponse(s);
    }

    // 4) Build trimmed sources & contextText (respect budgets)
    const sources = rows.map((r, i) => ({
      id: i + 1,
      source: r.source_file || `source_${i + 1}`,
      excerpt: (r.content || '').slice(0, MAX_EXCERPT)
    }));

    // build context pieces but cap total
    let tot = 0;
    const parts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT);
      if (tot + excerpt.length > MAX_CONTEXT_TOTAL) break;
      parts.push(`[${i + 1}] source: ${rows[i].source_file}\ncontent: ${excerpt}`);
      tot += excerpt.length;
    }
    const contextText = parts.join('\n\n---\n\n');

    // 5) System prompt with few-shot + structured output requirement
    // NOTE: We ask the model to include SUGGESTED JSON and SOURCES_JSON lines as part of the model output.
    const systemPrompt = `
You are a friendly, careful, and accurate assistant for U.S. immigration questions (students, employees, employers).

Rules:
- Use ONLY the CONTEXT / SOURCES below for factual claims. Do NOT hallucinate.
- Cite every factual claim with bracketed source numbers like [1], [2] that refer to the SOURCES block.
- Output structure: (1) Short direct answer (1-3 sentences), (2) Key points (bulleted list), (3) Next steps (1-3 actionable items).
- At the very end include two machine-parsable lines EXACTLY like:
  SUGGESTED: ["prompt 1", "prompt 2"]
  SOURCES_JSON: <json array of {id,source,excerpt}>
- Do NOT provide legal advice. If context is insufficient, say "I couldn't find supporting official sources in the provided documents."

Example:
Q: "Can I travel while on OPT?"
A: "Short answer: Usually yes for active OPT, but carry EAD and signed I-20. [1]
Key points:
- Carry EAD and signed I-20. [1]
Next steps:
- Check your school's international student office.

Then append:
SUGGESTED: ["How to prepare for OPT travel","What to carry when traveling on OPT"]
SOURCES_JSON: [{"id":1,"source":"uscis_opt_f1.txt","excerpt":"..."}]
`;

    // 6) Provide the context and the sources block to the model in the user prompt
    const userPrompt = `CONTEXT:
${contextText}

SOURCES:
${JSON.stringify(sources)}

QUESTION:
${userQuery}
`;

    const messagesForModel = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // 7) Call chat completion (streaming) with retry
    const completion = await createCompletionWithRetry(messagesForModel, /*stream*/ true);

    // 8) Stream model output directly (no custom preamble)
    // OpenAIStream returns a ReadableStream for the model output in Edge
    const modelStream = OpenAIStream(completion);

    // Return the model stream as-is so ai/react can parse it.
    return new StreamingTextResponse(modelStream);

  } catch (err) {
    console.error('chat handler error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
