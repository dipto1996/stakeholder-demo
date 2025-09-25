// chat.js — Final Production-Grade Version
// This version fixes the greeting handler to ensure all responses use a compatible stream format.
import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

export const config = { runtime: 'edge' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Configuration ---
const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const EMB_RETRIES = 3;
const CHAT_RETRIES = 2;
const MAX_EXCERPT = 1600;
const MAX_CONTEXT_TOTAL = 6000;

// --- Helper Functions ---
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

// --- Main API Handler ---
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const { messages } = await req.json();
    const userQuery = (messages[messages.length - 1].content || '').trim();
    if (!userQuery) return new Response('Empty user query', { status: 400 });

    // CORRECTED: The greeting handler now uses the OpenAI API to generate a response,
    // guaranteeing a stream format that is 100% compatible with the frontend.
    const GREETING_RE = /^(hi|hello|hey|good morning|good afternoon|good evening)\b/i;
    if (GREETING_RE.test(userQuery)) {
      const greetMessages = [
        { role: 'system', content: 'You are a friendly assistant for U.S. immigration questions. Greet the user concisely and ask how you can help.' },
        { role: 'user', content: userQuery },
      ];
      const greetCompletion = await createCompletionWithRetry(greetMessages);
      const greetStream = OpenAIStream(greetCompletion);
      return new StreamingTextResponse(greetStream);
    }

    const embResp = await createEmbeddingsWithRetry(userQuery);
    const queryEmbedding = embResp.data[0].embedding;

    const { rows } = await sql`
      SELECT content, source_file, source_title, source_url
      FROM documents
      ORDER BY embedding <=> ${JSON.stringify(queryEmbedding)}::vector
      LIMIT 5
    `;

    if (!rows || rows.length === 0) {
      const fallbackStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("I couldn't find supporting documents in our indexed sources for that question."));
          controller.close();
        }
      });
      return new StreamingTextResponse(fallbackStream);
    }

    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || r.source_file || "Untitled Source",
      url: r.source_url,
    }));

    let totalChars = 0;
    const contextParts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT);
      if (totalChars + excerpt.length > MAX_CONTEXT_TOTAL) break;
      contextParts.push(`[${i + 1}] source: ${rows[i].source_title || rows[i].source_file}\ncontent: ${excerpt}`);
      totalChars += excerpt.length;
    }
    const contextText = contextParts.join('\n\n---\n\n');

    const systemPrompt = `You are a friendly, careful, and accurate assistant for U.S. immigration questions. Rules: Use ONLY the CONTEXT below for factual claims. Cite facts using bracketed source numbers like [1], [2]. Output structure: (1) Short direct answer, (2) Key points (bulleted), (3) Next steps. At the very end, include a machine-parsable line exactly like: SOURCES_JSON:[{"id":1,"title":"Source Title","url":"https://..."}] Do NOT provide legal advice.`;
    const userPrompt = `CONTEXT:\n${contextText}\n\nQUESTION:\n${userQuery}`;

    const messagesForModel = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const completion = await createCompletionWithRetry(messagesForModel);
    const modelStream = OpenAIStream(completion);

    return new StreamingTextResponse(modelStream);

  } catch (err) {
    console.error('chat handler error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
