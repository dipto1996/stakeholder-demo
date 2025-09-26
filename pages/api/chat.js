// pages/api/chat.js — Polished, non-streaming JSON handler (Edge)
// - Edge runtime + @vercel/postgres
// - Robust retries for embeddings & completions
// - Smart context trimming
// - Clean, friendly, well-structured answers with [1][2] citations
// - Returns { answer, sources } JSON (compatible with your current index.js)

import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

export const config = { runtime: 'edge' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- Tunables ----
const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const EMB_RETRIES = 3;
const CHAT_RETRIES = 2;
const MAX_EXCERPT = 1600;       // per source excerpt, chars
const MAX_CONTEXT_TOTAL = 6000; // total chars across all excerpts

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { lastErr = e; await sleep(2 ** i * 500); }
  }
  throw lastErr;
}

async function embed(text) {
  const resp = await withRetry(
    () => openai.embeddings.create({ model: EMBEDDING_MODEL, input: text }),
    EMB_RETRIES
  );
  const v = resp?.data?.[0]?.embedding;
  if (!v) throw new Error('Embedding failed');
  return v;
}

function buildContextRows(rows) {
  // Build sources + trimmed context respecting total budget
  const sources = rows.map((r, i) => ({
    id: i + 1,
    title: r.source_title || r.source_file || 'Untitled',
    url: r.source_url || null,
  }));

  let used = 0;
  const blocks = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = (rows[i].content || '').slice(0, MAX_EXCERPT);
    if (used + raw.length > MAX_CONTEXT_TOTAL) break;
    blocks.push(
      `[${i + 1}] source: ${rows[i].source_title || rows[i].source_file || 'Untitled'}\ncontent: ${raw}`
    );
    used += raw.length;
  }
  return { sources, contextText: blocks.join('\n\n---\n\n') };
}

function okJSON(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function badRequest(msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const body = await req.json();
    const { messages } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return badRequest('Invalid request body');
    }

    const userQuery = (messages[messages.length - 1].content || '').trim();
    if (!userQuery) return badRequest('Empty user query');

    // Lightweight greeting path (still via model for consistent style)
    if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/i.test(userQuery)) {
      const greet = await withRetry(
        () => openai.chat.completions.create({
          model: CHAT_MODEL,
          stream: false,
          temperature: 0.2,
          messages: [
            { role: 'system', content:
              'You are a warm, succinct immigration info assistant. Greet briefly and ask how you can help.' },
            { role: 'user', content: userQuery },
          ],
        }),
        CHAT_RETRIES
      );
      const content = greet?.choices?.[0]?.message?.content?.trim() || 'Hello! How can I help?';
      return okJSON({ answer: content, sources: [] });
    }

    // --- RAG retrieval ---
    const qEmbedding = await embed(userQuery);

    const { rows } = await sql`
      SELECT content, source_title, source_url, source_file
      FROM documents
      ORDER BY embedding <=> ${JSON.stringify(qEmbedding)}::vector
      LIMIT 6
    `;

    if (!rows || rows.length === 0) {
      const msg =
        "I couldn't find supporting official sources in the provided documents.\n\n" +
        "**Next steps:**\n- Rephrase your question or add specifics (form number, visa type, date range).\n" +
        "- I can also try a broader explanation if you’d like.";
      return okJSON({ answer: msg, sources: [] });
    }

    const { sources, contextText } = buildContextRows(rows);

    // --- Prompting for polished answers ---
    const systemPrompt = `
You are a friendly, precise assistant for U.S. immigration information.
Requirements:
- Base your answer ONLY on the CONTEXT. If missing, say so plainly.
- Be concise but helpful. Use markdown with these sections:
  **Answer:** (2–4 sentences max, straight to the point)
  **Key Points:** (3–5 bullets, compact)
  **Next Steps:** (up to 3 bullets, action-oriented)
- Cite facts using bracketed numbers [1], [2] that correspond to the sources order below.
- Avoid legal advice. No filler language. Keep formatting clean.
- If the user asked about fees/policies that change, include a short “check latest on USCIS” note with a citation if present.

Output ONLY the formatted markdown answer (no JSON).`;

    const userPrompt =
`CONTEXT:
${contextText}

QUESTION:
${userQuery}
`;

    const completion = await withRetry(
      () => openai.chat.completions.create({
        model: CHAT_MODEL,
        stream: false,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt.trim() },
          { role: 'user', content: userPrompt },
        ],
      }),
      CHAT_RETRIES
    );

    let answer = completion?.choices?.[0]?.message?.content?.trim() || '';
    if (!answer) {
      answer =
        "Sorry — I couldn't generate a confident answer from the provided sources. " +
        "Try rephrasing or asking a more specific question.";
    }

    // Return JSON for your current UI
    return okJSON({ answer, sources });

  } catch (err) {
    console.error('chat api error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
