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
    const { messages } = req.body;
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

      Context: """
      ${contextText}
      """

      User Question: "${userQuery}"

      Answer:
    `;

    // We are NOT streaming for this test
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      stream: false, // Streaming is turned off
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    });

    const answer = response.choices[0].message.content;
    return res.status(200).json({ answer });

  } catch (error) {
    console.error('Error in chat API:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}
