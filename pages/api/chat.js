// pages/api/chat.js
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
const MAX_EXCERPT_LENGTH = 1600; // characters per excerpt
const MAX_CONTEXT_LENGTH = 6000;  // total characters of context

async function createEmbeddingsWithRetry(text) {
  for (let attempt = 0; attempt < EMB_RETRIES; attempt++) {
    try {
      const resp = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: text });
      if (!resp?.data?.[0]?.embedding) throw new Error('No embedding returned');
      return resp;
    } catch (err) {
      if (attempt === EMB_RETRIES - 1) throw err;
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
    } catch (err) {
      if (attempt === CHAT_RETRIES - 1) throw err;
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

    // Quick greeting shortcut (fast, avoids embeddings/cost)
    const GREETING_RE = /^(hi|hello|hey|good morning|good afternoon|good evening)[!.]?\s*$/i;
    if (GREETING_RE.test(userQuery)) {
      const greeting = "Hello! 👋 I can help explain U.S. immigration topics (H-1B, F-1, OPT, CPT). What would you like to know?";
      const s = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(greeting));
          controller.close();
        }
      });
      return new StreamingTextResponse(s);
    }

    // 1) Embedding (retry)
    const embResp = await createEmbeddingsWithRetry(userQuery);
    const queryEmbedding = embResp.data[0].embedding;
    const embLiteral = JSON.stringify(queryEmbedding);

    // 2) Retrieve top-k relevant documents from Neon/Postgres via @vercel/postgres
    // Note: cast to ::vector in SQL; @vercel/postgres will substitute our embLiteral string safely
    const q = await sql`
      SELECT source_title, source_url, content
      FROM documents
      ORDER BY embedding <=> ${embLiteral}::vector
      LIMIT 6
    `;
    const rows = q?.rows ?? [];

    // 3) No results fallback
    if (!rows || rows.length === 0) {
      const fallback = "I couldn't find supporting documents in our indexed sources for that question. Would you like (A) a broader search, (B) general guidance, or (C) lawyer review?";
      const s = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(fallback));
          controller.close();
        }
      });
      return new StreamingTextResponse(s);
    }

    // 4) Build trimmed context and sources list (respect budgets)
    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || `Source ${i + 1}`,
      url: r.source_url || null,
    }));

    let totalChars = 0;
    const contextParts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT_LENGTH);
      if (totalChars + excerpt.length > MAX_CONTEXT_LENGTH) break;
      contextParts.push(`[${i + 1}] title: ${rows[i].source_title || `source_${i+1}`}\ncontent: ${excerpt}`);
      totalChars += excerpt.length;
    }
    const contextText = contextParts.join('\n\n---\n\n');

    // 5) System + user prompt (conversational + citation instructions)
    const systemPrompt = `You are a friendly, careful AI assistant for U.S. immigration questions. Use ONLY the provided CONTEXT / SOURCES for factual claims. Cite facts with bracketed numbers like [1], [2] that map to the SOURCES block. Provide a short direct answer, then key points (bullet list), then next steps. Do NOT provide legal advice. If the context is insufficient, say you couldn't find the answer in the provided documents. At the end, output a machine-parsable SUGGESTED line: SUGGESTED: ["followup 1","followup 2"]`;

    const userPrompt = `CONTEXT:\n${contextText}\n\nQUESTION:\n${userQuery}`;

    const messagesForModel = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // 6) Call chat completion (streaming) with retry
    const completion = await createCompletionWithRetry(messagesForModel);

    // 7) Build preamble with sources and stream combined output
    const preamble = `SOURCES_JSON:${JSON.stringify(sources)}\n\n`;
    const encodedPreamble = new TextEncoder().encode(preamble);
    const modelStream = OpenAIStream(completion);

    const combined = new ReadableStream({
      async start(controller) {
        // send preamble then model stream
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
