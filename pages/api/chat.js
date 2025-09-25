// pages/api/chat.js — robust RAG chat handler with safe fallback
import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

export const config = { runtime: 'edge' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const EMB_RETRIES = 3;
const CHAT_RETRIES = 2;
const MAX_EXCERPT = 1600;
const MAX_CONTEXT_TOTAL = 6000;

async function createEmbeddingsWithRetry(input) {
  for (let attempt = 0; attempt < EMB_RETRIES; attempt++) {
    try {
      const resp = await openai.embeddings.create({ model: EMBEDDING_MODEL, input });
      if (!resp?.data?.[0]?.embedding) throw new Error('No embedding returned');
      return resp;
    } catch (err) {
      console.error(`Embedding attempt ${attempt + 1} failed:`, err?.message || err);
      if (attempt === EMB_RETRIES - 1) throw err;
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
    } catch (err) {
      console.error(`Completion attempt ${attempt + 1} failed:`, err?.message || err);
      if (attempt === CHAT_RETRIES - 1) throw err;
      await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
    }
  }
}

function makeTextStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    const body = await req.json();
    const { messages } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) return new Response('Invalid request body', { status: 400 });

    const userQuery = (messages[messages.length - 1].content || '').trim();
    if (!userQuery) return new Response('Empty user query', { status: 400 });

    const GREETING_RE = /^(hi|hello|hey|good morning|good afternoon|good evening)\b/i;
    if (GREETING_RE.test(userQuery)) {
      // use model for greeting to ensure consistent stream shape
      try {
        const greetMessages = [
          { role: 'system', content: 'You are a friendly U.S. immigration assistant. Give a concise greeting and ask how to help.' },
          { role: 'user', content: userQuery }
        ];
        const greetCompletion = await createCompletionWithRetry(greetMessages);
        const greetStream = OpenAIStream(greetCompletion);
        return new StreamingTextResponse(greetStream);
      } catch (gErr) {
        console.error('Greeting completion failed, sending simple text fallback:', gErr);
        return new StreamingTextResponse(makeTextStream("Hello! How can I help with your U.S. immigration questions?"));
      }
    }

    // Attempt RAG flow
    let queryEmbedding;
    try {
      const embResp = await createEmbeddingsWithRetry(userQuery);
      queryEmbedding = embResp.data[0].embedding;
    } catch (e) {
      console.error('Embeddings failed — will fallback to non-RAG completion:', e?.message || e);
    }

    let rows = [];
    if (queryEmbedding) {
      try {
        const embLiteral = JSON.stringify(queryEmbedding);
        const q = await sql`
          SELECT source_title, source_url, content 
          FROM documents
          ORDER BY embedding <=> ${embLiteral}::vector
          LIMIT 6
        `;
        rows = q?.rows ?? [];
      } catch (dbErr) {
        console.error('DB retrieval failed — will fallback to non-RAG completion:', dbErr?.message || dbErr);
      }
    }

    // If retrieval succeeded and we have rows, build RAG prompt
    if (rows && rows.length > 0) {
      try {
        const sources = rows.map((r, i) => ({
          id: i + 1,
          title: r.source_title || r.source_url || `source_${i+1}`,
          url: r.source_url || null
        }));

        // build context within budgets
        let total = 0;
        const parts = [];
        for (let i = 0; i < rows.length; i++) {
          const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT);
          if (total + excerpt.length > MAX_CONTEXT_TOTAL) break;
          parts.push(`[${i + 1}] ${rows[i].source_title || rows[i].source_url || `source_${i+1}`}\n${excerpt}`);
          total += excerpt.length;
        }
        const contextText = parts.join('\n\n---\n\n');

        const systemPrompt = `You are a helpful, professional assistant for U.S. immigration questions.
Rules:
- Use ONLY the CONTEXT below for factual claims and cite using [1], [2], etc.
- If context is insufficient, say "I couldn't find an authoritative source in the provided documents."
Output (markdown-friendly):
1) Short direct answer (1-3 sentences)
2) Key points (bulleted)
3) Next steps (1-3 actionable items)
At the end append a single preamble line exactly: SOURCES_JSON:<ARRAY> (server will also send this). Do NOT provide legal advice.`;

        const userPrompt = `CONTEXT:\n${contextText}\n\nQUESTION:\n${userQuery}`;

        const messagesForModel = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ];

        const completion = await createCompletionWithRetry(messagesForModel);
        const modelStream = OpenAIStream(completion);

        // send server SOURCES_JSON preamble only if we have sources
        const preamble = `SOURCES_JSON:${JSON.stringify(sources)}\n\n`;
        const encodedPreamble = new TextEncoder().encode(preamble);

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
      } catch (ragErr) {
        console.error('RAG flow failed — falling back to non-RAG completion:', ragErr?.message || ragErr);
        // fallthrough to non-RAG below
      }
    }

    // Non-RAG fallback: answer from model without context (so user gets something)
    try {
      const fallbackSystem = 'You are a friendly U.S. immigration assistant. Answer clearly and concisely. If unsure, say you are not sure.';
      const fallbackMessages = [
        { role: 'system', content: fallbackSystem },
        { role: 'user', content: userQuery }
      ];
      const completion = await createCompletionWithRetry(fallbackMessages);
      const stream = OpenAIStream(completion);
      return new StreamingTextResponse(stream);
    } catch (finalErr) {
      console.error('Non-RAG completion also failed:', finalErr);
      return new StreamingTextResponse(makeTextStream("Sorry — I'm having trouble right now. Please try again later."));
    }
  } catch (err) {
    console.error('Unhandled error in /api/chat:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
