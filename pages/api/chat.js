// pages/api/chat.js
// Edge-ready RAG chat endpoint that sends a SOURCES_JSON preamble then streams the model output.
// Requires: @vercel/postgres, openai, ai (OpenAIStream, StreamingTextResponse)

import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

export const config = { runtime: 'edge' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Tunables
const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const EMB_RETRIES = 3;
const CHAT_RETRIES = 2;
const MAX_EXCERPT = 1600;    // per-source excerpt chars
const MAX_CONTEXT_TOTAL = 6000; // total chars across excerpts

async function createEmbeddingsWithRetry(input) {
  for (let attempt = 0; attempt < EMB_RETRIES; attempt++) {
    try {
      const resp = await openai.embeddings.create({ model: EMBEDDING_MODEL, input });
      if (!resp?.data?.[0]?.embedding) throw new Error('No embedding');
      return resp;
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

    // quick greeting shortcut (no DB / LLM call)
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

    // 1) Embedding
    const embResp = await createEmbeddingsWithRetry(userQuery);
    const queryEmbedding = embResp.data[0].embedding;
    const embLiteral = JSON.stringify(queryEmbedding);

    // 2) Retrieve matching docs (assumes documents table has source_title, source_url, content)
    // Note: cast must be ::vector in Neon/Postgres with vector extension.
    const q = await sql`
      SELECT source_title, source_url, content
      FROM documents
      ORDER BY embedding <=> ${embLiteral}::vector
      LIMIT 6
    `;
    const rows = q?.rows ?? [];

    // 3) If nothing found: return friendly fallback (no LLM)
    if (!rows || rows.length === 0) {
      const fallback = "I couldn't find supporting official sources in the provided documents. Would you like (A) a broader search, (B) general guidance, or (C) lawyer review?";
      const s = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(fallback));
          controller.close();
        }
      });
      return new StreamingTextResponse(s);
    }

    // 4) Build sources and context, trimming as needed
    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || (r.source_url ? r.source_url : `source_${i+1}`),
      url: r.source_url || null
    }));

    let total = 0;
    const parts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT);
      if (total + excerpt.length > MAX_CONTEXT_TOTAL) break;
      parts.push(`[${i + 1}] source_title: ${rows[i].source_title || ''}\ncontent: ${excerpt}`);
      total += excerpt.length;
    }
    const contextText = parts.join('\n\n---\n\n');

    // 5) Prompt engineering (structured output + citation requirement)
    const systemPrompt = `
You are a friendly and professional AI assistant for U.S. immigration questions.
Rules:
- Use ONLY the CONTEXT / SOURCES below for factual claims. Do NOT hallucinate.
- Cite every factual claim with bracketed source numbers like [1], [2] that map to the SOURCES_JSON array.
- Output structure: (1) Short direct answer (1-3 sentences), (2) Key points (bulleted list), (3) Next steps (1-3 actionable items).
- At the end include SUGGESTED: ["prompt 1","prompt 2"] with suggested follow-ups.
- Do NOT provide legal advice. If the context is insufficient, say "I couldn't find supporting official sources in the provided documents."
`.trim();

    const userPrompt = `CONTEXT:
${contextText}

QUESTION:
${userQuery}
`;

    const messagesForModel = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // 6) Get model completion (streaming)
    const completion = await createCompletionWithRetry(messagesForModel, true);

    // 7) Stream preamble (SOURCES_JSON) first, then model stream
    const preamble = `SOURCES_JSON:${JSON.stringify(sources)}\n\n`;
    const encodedPreamble = new TextEncoder().encode(preamble);
    const modelStream = OpenAIStream(completion); // returns a ReadableStream

    const combined = new ReadableStream({
      async start(controller) {
        // send preamble first (frontend will parse this)
        controller.enqueue(encodedPreamble);

        const reader = modelStream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      }
    });

    return new StreamingTextResponse(combined);

  } catch (err) {
    console.error('chat handler error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
