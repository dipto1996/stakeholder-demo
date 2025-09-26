// pages/api/conversations/save.js
import { sql } from '@vercel/postgres';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user?.email) return res.status(401).json({ error: 'Not authenticated' });

    const { title, messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages required' });
    }

    // lookup/create user row by email
    const { rows: userRows } = await sql`
      INSERT INTO users (email)
      VALUES (${session.user.email})
      ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
      RETURNING id;
    `;
    const userId = userRows[0].id;

    // default title: first 60 chars of the first user message
    const firstUserMsg = messages.find(m => m.role === 'user')?.content || 'Conversation';
    const safeTitle = (title || firstUserMsg).slice(0, 60);

    await sql`
      INSERT INTO conversations (user_id, title, messages)
      VALUES (${userId}, ${safeTitle}, ${JSON.stringify(messages)}::jsonb)
    `;

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('save conversation error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
