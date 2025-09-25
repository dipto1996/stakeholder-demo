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
const MAX_EXCERPT = 1400;
const MAX_CONTEXT_TOTAL = 5000;

async function createEmbeddingsWithRetry(input) {
  for (let attempt = 0; attempt < EMB_RETRIES; attempt++) {
    try {
      const resp = await openai.embeddings.create({ model: EMBEDDING_MODEL, input });
      if (!resp?.data?.[0]?.embedding) throw new Error('No embedding returned');
      return resp;
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

    // Greeting shortcut — use model produced stream (keeps consistent stream format)
    const GREETING_RE = /^(hi|hello|hey|good morning|good afternoon|good evening)\b/i;
    if (GREETING_RE.test(userQuery)) {
      const greetMessages = [
        { role: 'system', content: 'You are a concise, friendly U.S. immigration assistant.' },
        { role: 'user', content: userQuery },
      ];
      const greetCompletion = await createCompletionWithRetry(greetMessages);
      const greetStream = OpenAIStream(greetCompletion);
      return new StreamingTextResponse(greetStream);
    }

    // 1) Embedding
    const embResp = await createEmbeddingsWithRetry(userQuery);
    const queryEmbedding = embResp.data[0].embedding;
    const embLiteral = JSON.stringify(queryEmbedding);

    // 2) Retrieve top-K docs (pgvector cast)
    const q = await sql`
      SELECT source_title, source_url, content
      FROM documents
      ORDER BY embedding <=> ${embLiteral}::vector
      LIMIT 6
    `;
    const rows = q?.rows ?? [];

    // 3) fallback if no rows found
    if (!rows || rows.length === 0) {
      const fallback = "I couldn't find supporting documents in our indexed sources for that question.";
      const s = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(fallback));
          controller.close();
        }
      });
      return new StreamingTextResponse(s);
    }

    // 4) Build sources and context, trimmed
    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || r.source_url || `source_${i + 1}`,
      url: r.source_url || null
    }));

    let tot = 0;
    const parts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT);
      if (tot + excerpt.length > MAX_CONTEXT_TOTAL) break;
      parts.push(`[${i + 1}] source: ${rows[i].source_title || rows[i].source_url || 'Unknown'}\ncontent: ${excerpt}`);
      tot += excerpt.length;
    }
    const contextText = parts.join('\n\n---\n\n');

    // 5) System + user prompt
    const systemPrompt = `
You are a friendly and professional AI assistant for U.S. immigration questions.
Rules:
- Use ONLY the provided CONTEXT / SOURCES for factual claims (do NOT hallucinate).
- Cite facts with bracketed source numbers like [1], [2].
- Output structure: (1) Short direct answer (1-3 sentences), (2) Key points (bulleted), (3) Next steps (1-3).
- Do NOT provide legal advice.
At the end include a machine-parsable SUGGESTED array like: SUGGESTED: ["follow-up 1","follow-up 2"]
`.trim();

    const userPrompt = `CONTEXT:\n${contextText}\n\nQUESTION:\n${userQuery}`;

    const messagesForModel = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // 6) Get streaming completion
    const completion = await createCompletionWithRetry(messagesForModel);

    // 7) Prepare textual preamble with SOURCES_JSON and optional SUGGESTED (frontend will parse this)
    const preambleObj = {
      sources
    };
    const preambleText = `SOURCES_JSON:${JSON.stringify(preambleObj.sources)}\n\n`;
    const encodedPreamble = new TextEncoder().encode(preambleText);

    // 8) Pipe preamble followed by model stream so legacy & current frontends can parse reliably
    const modelStream = OpenAIStream(completion);
    const combined = new ReadableStream({
      async start(controller) {
        // send preamble first
        controller.enqueue(encodedPreamble);
        // then pipe the model stream
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
