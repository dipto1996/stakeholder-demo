// chat.js — Full Edge-ready RAG chat handler (complete file)
// - Edge runtime (export const config = { runtime: 'edge' })
// - Uses @vercel/postgres for vector retrieval
// - OpenAI embeddings + chat completions (streaming)
// - Greeting handled via streaming completion so ai/react recognizes it
// - No raw preamble; model may append SOURCES_JSON at end (system prompt)
// - Retries and context trimming included

import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

export const config = { runtime: 'edge' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Tunables
const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const VECTOR_DIMENSION = 1536;
const MAX_EXCERPT = 1600; // per source excerpt (chars)
const MAX_CONTEXT_TOTAL = 6000; // total chars across all excerpts
const EMB_RETRIES = 3;
const CHAT_RETRIES = 2;

// Helpers
async function createEmbeddingsWithRetry(input, retries = EMB_RETRIES) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await openai.embeddings.create({ model: EMBEDDING_MODEL, input });
      if (!resp?.data?.[0]?.embedding) throw new Error('No embedding returned');
      return resp;
    } catch (e) {
      if (attempt === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    }
  }
}

async function createCompletionWithRetry(messages, stream = true, retries = CHAT_RETRIES) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await openai.chat.completions.create({
        model: CHAT_MODEL,
        stream,
        messages,
        temperature: 0.15,
      });
    } catch (e) {
      if (attempt === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    }
  }
}

// Main handler
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

    // Quick greeting shortcut: return a proper assistant completion stream
    const GREETING_RE = /^(hi|hello|hey|good morning|good afternoon|good evening)\b/i;
    if (GREETING_RE.test(userQuery)) {
      const greetMessages = [
        { role: 'system', content: 'You are a friendly assistant for U.S. immigration questions. Keep replies concise and helpful.' },
        { role: 'user', content: userQuery },
      ];
      const greetCompletion = await createCompletionWithRetry(greetMessages, true);
      const greetStream = OpenAIStream(greetCompletion);
      return new StreamingTextResponse(greetStream);
    }

    // 1) Create query embedding
    const embResp = await createEmbeddingsWithRetry(userQuery);
    const queryEmbedding = embResp.data[0].embedding;
    const embLiteral = JSON.stringify(queryEmbedding);

    // 2) Retrieve top-k from Postgres (pgvector) using @vercel/postgres sql tagged template
    const q = await sql`
      SELECT content, source_file
      FROM documents
      ORDER BY embedding <=> ${embLiteral}::vector
      LIMIT 6
    `;
    const rows = q?.rows ?? [];

    // 3) Friendly fallback if no docs
    if (!rows || rows.length === 0) {
      const fallback = "I couldn't find supporting documents in our indexed sources for that question. Would you like (A) broader search, (B) general guidance, or (C) lawyer review?";
      const s = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(fallback));
          controller.close();
        },
      });
      return new StreamingTextResponse(s);
    }

    // 4) Build trimmed context and structured sources
    const sources = rows.map((r, i) => ({
      id: i + 1,
      source: r.source_file || `source_${i + 1}`,
      excerpt: (r.content || '').slice(0, MAX_EXCERPT),
    }));

    let tot = 0;
    const parts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT);
      if (tot + excerpt.length > MAX_CONTEXT_TOTAL) break;
      parts.push(`[${i + 1}] source: ${rows[i].source_file}\ncontent: ${excerpt}`);
      tot += excerpt.length;
    }
    const contextText = parts.join('\n\n---\n\n');

    // 5) System prompt instructing citations and structured output
    const systemPrompt = `
You are a friendly, careful, and accurate assistant for U.S. immigration questions.
Rules:
- Use ONLY the CONTEXT below for factual claims. Do NOT hallucinate.
- Cite facts using bracketed source numbers like [1], [2] that reference the SOURCES in the CONTEXT.
- Output structure: (1) Short direct answer (1-3 sentences), (2) Key points (bulleted), (3) Next steps (1-3 actionable items).
- At the very end include a compact machine-parsable line exactly like: SOURCES_JSON: [{"id":1,"source":"file.txt","excerpt":"..."}]
- Do NOT provide legal advice. If context is insufficient, say "I couldn't find supporting official sources in the provided documents."
`.trim();

    const userPrompt = `CONTEXT:
${contextText}

QUESTION:
${userQuery}
`;

    const messagesForModel = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    // 6) Get streaming completion and forward it directly to client (no manual preamble)
    const completion = await createCompletionWithRetry(messagesForModel, true);
    const modelStream = OpenAIStream(completion);

    return new StreamingTextResponse(modelStream);
  } catch (err) {
    console.error('chat handler error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
