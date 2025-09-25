// pages/api/chat.js — Edge-ready RAG chat handler (final presentable version)
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
    } catch (e) {
      if (attempt === EMB_RETRIES - 1) throw e;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
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
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    }
  }
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const { messages } = await req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response('Invalid request body', { status: 400 });
    }
    const userQuery = (messages[messages.length - 1].content || '').trim();
    if (!userQuery) return new Response('Empty user query', { status: 400 });

    // Greeting shortcut that returns a proper model stream (keeps behaviour consistent)
    const GREETING_RE = /^(hi|hello|hey|good morning|good afternoon|good evening)\b/i;
    if (GREETING_RE.test(userQuery)) {
      // Use model to produce a nicely formatted greeting (guarantees streaming format)
      const greetMessages = [
        { role: 'system', content: 'You are a friendly U.S. immigration assistant. Greet the user concisely and offer next-step suggested prompts.' },
        { role: 'user', content: userQuery }
      ];
      const greetCompletion = await createCompletionWithRetry(greetMessages);
      const greetStream = OpenAIStream(greetCompletion);
      return new StreamingTextResponse(greetStream);
    }

    // 1) Query embedding
    const embResp = await createEmbeddingsWithRetry(userQuery);
    const queryEmbedding = embResp.data[0].embedding;
    const embLiteral = JSON.stringify(queryEmbedding);

    // 2) RAG retrieval
    const q = await sql`
      SELECT source_title, source_url, content
      FROM documents
      ORDER BY embedding <=> ${embLiteral}::vector
      LIMIT 6
    `;
    const rows = q?.rows ?? [];

    if (!rows || rows.length === 0) {
      const fallback = "I couldn't find supporting documents in our indexed sources for that question. Would you like me to (A) broaden the search, (B) answer from general knowledge, or (C) show you lawyer resources?";
      const s = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(fallback));
          controller.close();
        }
      });
      return new StreamingTextResponse(s);
    }

    // 3) Build sources (defensive: always include a readable title)
    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || r.source_url || `source_${i+1}`,
      url: r.source_url || null
    }));

    // 4) Build context text within length budget
    let tot = 0;
    const parts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT);
      if (tot + excerpt.length > MAX_CONTEXT_TOTAL) break;
      parts.push(`[${i + 1}] ${rows[i].source_title || rows[i].source_url || `source_${i+1}`}\n${excerpt}`);
      tot += excerpt.length;
    }
    const contextText = parts.join('\n\n---\n\n');

    // 5) Strong, presentable system prompt (encourage polished, readable output)
    const systemPrompt = `
You are a helpful, professional, and conversational assistant for U.S. immigration topics. Follow these rules strictly:
- Use ONLY the CONTEXT below for factual information and cite sources inline using [1], [2], etc.
- If the context doesn't contain the answer, say "I couldn't find an authoritative source in the provided documents."
- Output format (markdown-compatible):
  1) Short direct answer (1-3 sentences).
  2) Key points (bullet list).
  3) Next steps (1-3 practical actions).
- Be concise, friendly, and avoid legal advice wording.
At the end of your response append a single machine-parsable preamble line exactly like:
SOURCES_JSON:<ARRAY>
where <ARRAY> is a JSON array of objects with keys id,title,url (the server will also send one).
`;

    const userPrompt = `CONTEXT:\n${contextText}\n\nQUESTION:\n${userQuery}`;

    const messagesForModel = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // 6) Ask the model to produce a polished answer
    const completion = await createCompletionWithRetry(messagesForModel);
    const modelStream = OpenAIStream(completion);

    // 7) Prepend server-generated SOURCES_JSON (defensive canonical metadata)
    const fixedSources = sources.map(s => ({
      id: s.id,
      title: s.title,
      url: s.url || null
    }));
    const preamble = `SOURCES_JSON:${JSON.stringify(fixedSources)}\n\n`;
    const encodedPreamble = new TextEncoder().encode(preamble);

    // Combine preamble + model stream
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
