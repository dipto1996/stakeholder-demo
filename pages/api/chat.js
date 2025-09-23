// pages/api/chat.js
import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

export const config = {
  runtime: 'edge',
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const GREETINGS = new Set(['hi','hello','hey','hiya','good morning','good afternoon','good evening']);

function extractJsonFromText(text){
  if(!text || typeof text !== 'string') return null;
  const first = text.indexOf('{');
  if(first === -1) return null;
  let depth = 0;
  for(let i = first; i < text.length; i++){
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth === 0) {
      const candidate = text.substring(first, i+1);
      try { return JSON.parse(candidate); } catch(e) { break; }
    }
  }
  const m = text.match(/\{[\s\S]*\}/);
  if(m) {
    try { return JSON.parse(m[0]); } catch(e){}
  }
  return null;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' }});
  }

  let body;
  try { body = await req.json(); } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' }});
  }

  // Accept messages[] (chat) or { query: "..." }
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  let userQuery = '';
  if (messages && messages.length) {
    userQuery = (messages[messages.length - 1].content || '').trim();
  } else if (typeof body.query === 'string') {
    userQuery = body.query.trim();
  }

  if (!userQuery) {
    return new Response(JSON.stringify({ error: 'Empty query' }), { status: 400, headers: { 'Content-Type': 'application/json' }});
  }

  // Greeting shortcut
  const lc = userQuery.toLowerCase();
  if (GREETINGS.has(lc) || GREETINGS.has(lc.split(' ')[0])) {
    return new Response(JSON.stringify({
      mode: 'local_greeting',
      response: {
        answer: "Hi — I'm your immigration helper. I can explain rules, point to official sources, or summarize recent news. What would you like to ask about?",
        citations: [],
        confidence: 'High',
        next_steps: ['Ask a specific question about H-1B, OPT, F-1 travel, visas, or procedures.'],
        escalate: false
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' }});
  }

  // Compute embedding (RAG)
  let queryEmbedding;
  try {
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: userQuery,
    });
    if (!emb?.data?.[0]?.embedding) throw new Error('No embedding returned');
    queryEmbedding = emb.data[0].embedding;
  } catch (err) {
    console.error('Embedding error', err);
    // fallback: return retrieved excerpts empty so UI doesn't hang
    return new Response(JSON.stringify({ mode: 'error', error: 'Embedding failed' }), { status: 200, headers: { 'Content-Type': 'application/json' }});
  }

  // Retrieve top contexts from Postgres (RAG). Keep same JSON-string approach as before for compatibility.
  let rows;
  try {
    const q = await sql`
      SELECT content, source, id
      FROM documents
      ORDER BY embedding <=> ${JSON.stringify(queryEmbedding)}
      LIMIT 5
    `;
    rows = q?.rows || [];
  } catch (err) {
    console.error('DB query error', err);
    return new Response(JSON.stringify({ mode: 'error', error: 'DB retrieval failed' }), { status: 200, headers: { 'Content-Type': 'application/json' }});
  }

  const contexts = rows.map(r => ({
    id: r.id ?? null,
    source: r.source ?? null,
    content: r.content ?? ''
  }));

  const contextText = contexts.map((c,i)=>`[${i+1}] Source: ${c.source || 'unknown'}\n${c.content}`).join('\n\n---\n\n') || '[no contexts found]';

  // Build system + few-shot prompt (conversational + constrained)
  const system = `You are a friendly, conversational assistant specialized in U.S. immigration. USE ONLY the CONTEXT provided for factual claims. Cite with [n] referencing the context blocks given. If the context doesn't support an answer, respond: "I couldn't find supporting official sources in the provided documents." Do NOT provide legal advice. Keep tone helpful.`;

  const fewShot = `
EXAMPLE
User: "hi"
Assistant: "Hi — I’m your immigration helper. What would you like to ask about today?"

EXAMPLE
Context:
[1] USCIS OPT guidance: When traveling on OPT, carry EAD and an endorsed I-20.

User: "What should I carry when traveling on OPT?"
Assistant: "Carry your EAD card, passport, and I-20 with travel endorsement. [1]"
`.trim();

  const userPrompt = `
FEW_SHOT:
${fewShot}

CONTEXT:
${contextText}

USER QUESTION:
${userQuery}

INSTRUCTIONS:
- Use ONLY the CONTEXT for factual claims.
- Output a single JSON object ONLY (no extra commentary) with keys:
  { "answer": string, "citations": [{"id": number, "source": string}], "confidence": "High|Medium|Low", "next_steps": [string], "escalate": boolean }
- Make "answer" conversational and friendly. If you cannot answer from context, set answer to "I couldn't find supporting official sources in the provided documents." and return citations: [].
`.trim();

  // Call OpenAI (non-streaming, deterministic-ish)
  try {
    const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: system },
        { role: 'system', content: fewShot },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.15,
      max_tokens: 600,
    });

    const content = resp?.choices?.[0]?.message?.content || '';
    const parsed = extractJsonFromText(content);

    if (parsed && parsed.answer) {
      return new Response(JSON.stringify({ mode: 'openai', response: parsed, raw: content, retrieved: contexts }), { status: 200, headers: { 'Content-Type': 'application/json' }});
    }

    // invalid model output — fallback: return retrieved contexts so UI shows excerpts
    return new Response(JSON.stringify({ mode: 'openai_unverified', raw: content, retrieved: contexts }), { status: 200, headers: { 'Content-Type': 'application/json' }});

  } catch (err) {
    console.error('OpenAI call error', err);
    return new Response(JSON.stringify({ mode: 'error', error: 'LLM call failed', retrieved: contexts }), { status: 200, headers: { 'Content-Type': 'application/json' }});
  }
}
