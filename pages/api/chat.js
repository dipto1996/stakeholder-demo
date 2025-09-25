// pages/api/chat.js (Edge)
import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

export const config = { runtime: 'edge' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const EMB_RETRIES = 3;
const CHAT_RETRIES = 2;
const MAX_EXCERPT = 1200;
const MAX_CONTEXT_TOTAL = 6000;

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

async function createCompletionWithRetry(messages) {
  for (let attempt = 0; attempt < CHAT_RETRIES; attempt++) {
    try {
      return await openai.chat.completions.create({
        model: CHAT_MODEL,
        stream: true,
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

    // greeting shortcut
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

    // 1. embedding
    const embResp = await createEmbeddingsWithRetry(userQuery);
    if (!embResp?.data?.[0]?.embedding) throw new Error('Embedding failed');
    const queryEmbedding = embResp.data[0].embedding;
    const embLiteral = JSON.stringify(queryEmbedding);

    // 2. retrieve rows including source_title and source_url
    const q = await sql`
      SELECT content, source_url, source_title, source_file
      FROM documents
      ORDER BY embedding <=> ${embLiteral}::vector
      LIMIT 6
    `;
    const rows = q?.rows ?? [];

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

    // build sources and trimmed context
    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || r.source_url || r.source_file || `source_${i+1}`,
      url: r.source_url || null,
      excerpt: (r.content || '').slice(0, MAX_EXCERPT)
    }));

    let tot = 0;
    const parts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT);
      if (tot + excerpt.length > MAX_CONTEXT_TOTAL) break;
      const src = rows[i].source_title || rows[i].source_url || rows[i].source_file || `source_${i+1}`;
      parts.push(`[${i+1}] ${src}\n${excerpt}`);
      tot += excerpt.length;
    }
    const contextText = parts.join('\n\n---\n\n');

    // system prompt instructs to cite by number
    const systemPrompt = `You are a friendly, careful, and accurate assistant for U.S. immigration questions.
Rules:
- Use ONLY the CONTEXT / SOURCES below for factual claims. Do NOT hallucinate.
- Cite every factual claim with bracketed source numbers like [1], [2] that refer to the SOURCES block.
- Output structure: (1) Short direct answer (1-3 sentences), (2) Key points (bulleted list), (3) Next steps (1-3 actionable items).
- At the end include machine-parsable SUGGESTED: ["prompt1","prompt2"] for UI follow-ups.
- Do NOT provide legal advice. If context is insufficient, say "I couldn't find supporting official sources in the provided documents."`;

    const userPrompt = `CONTEXT:\n${contextText}\n\nQUESTION:\n${userQuery}`;

    const messagesForModel = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // create streaming completion
    const completion = await createCompletionWithRetry(messagesForModel);

    // preamble with structured sources JSON (frontend will parse SOURCES_JSON)
    const preamble = `SOURCES_JSON:${JSON.stringify(sources)}\n\n`;
    const encodedPreamble = new TextEncoder().encode(preamble);

    const modelStream = OpenAIStream(completion);

    const combined = new ReadableStream({
      async start(controller) {
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
