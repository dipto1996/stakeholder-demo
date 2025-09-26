// pages/api/chat.js — JSON response for your working UI
import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// optional: use Edge if you want, but Node.js is fine with NextAuth in the app too
export const config = { runtime: 'edge' };

const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const MAX_EXCERPT = 1600;
const MAX_CONTEXT_TOTAL = 6000;

async function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  try {
    const { messages } = await req.json();
    const userQuery = (messages?.[messages.length - 1]?.content || '').trim();
    if (!userQuery) return json({ error: 'Empty user query' }, 400);

    // Friendly greeting path — still JSON so UI renders it
    if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/i.test(userQuery)) {
      return json({
        answer:
          'Hello! How can I help with your U.S. immigration questions today?',
        sources: [],
      });
    }

    // 1) Embed query
    const emb = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: userQuery,
    });
    const queryEmbedding = emb.data[0].embedding;

    // 2) Top-k retrieval with citation fields
    const { rows } = await sql`
      SELECT content, source_title, source_url
      FROM documents
      ORDER BY embedding <=> ${JSON.stringify(queryEmbedding)}::vector
      LIMIT 6
    `;

    if (!rows || rows.length === 0) {
      return json({
        answer:
          "I couldn't find supporting official sources in the provided documents. Want me to try a broader search?",
        sources: [],
      });
    }

    // Build sources list for UI
    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || 'Untitled Source',
      url: r.source_url || null,
    }));

    // Build limited context
    let tot = 0;
    const parts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT);
      if (tot + excerpt.length > MAX_CONTEXT_TOTAL) break;
      parts.push(`[${i + 1}] ${rows[i].source_title || 'Source'}\n${excerpt}`);
      tot += excerpt.length;
    }
    const contextText = parts.join('\n\n---\n\n');

    // 3) Ask the model (non-streaming) — return only the answer text
    const systemPrompt =
      'You are a friendly, careful assistant for U.S. immigration. ' +
      'Use ONLY the CONTEXT below for factual claims and cite with [1],[2]. ' +
      'Structure: short answer, key points (bullets), next steps. Do not provide legal advice.';
    const userPrompt = `CONTEXT:\n${contextText}\n\nQUESTION:\n${userQuery}`;

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      stream: false,
      temperature: 0.15,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const answer =
      completion.choices?.[0]?.message?.content?.trim() ||
      'Sorry — I could not generate an answer.';

    // 4) Return plain JSON for your working UI
    return json({ answer, sources });
  } catch (err) {
    console.error('chat error:', err);
    return json({ error: 'Internal Server Error' }, 500);
  }
}
