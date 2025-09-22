import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';
import { Pool } from 'pg';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { messages } = await req.json();
    const userQuery = messages[messages.length - 1].content;

    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: userQuery,
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

    const client = await pool.connect();
    let contextText = '';
    try {
      const { rows } = await client.query(
        'SELECT content FROM documents ORDER BY embedding <=> $1 LIMIT 5',
        [JSON.stringify(queryEmbedding)]
      );
      contextText = rows.map(r => r.content).join('\n\n---\n\n');
    } finally {
      client.release();
    }

    const prompt = `
      You are a highly intelligent AI assistant for U.S. immigration questions.
      Answer the user's question based ONLY on the provided context below.
      The context contains excerpts from the USCIS Policy Manual and other official sources.
      If the context does not contain enough information to answer the question, state that you cannot find the information in the provided documents.
      Do not provide legal advice.

      Context: """
      ${contextText}
      """

      User Question: "${userQuery}"

      Answer:
    `;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    });

    const stream = OpenAIStream(response);

    // This handles streaming in a standard Node.js environment
    if (res && typeof res.writeHead === 'function') {
