// pages/api/conversations/save.js
export const config = { runtime: 'nodejs' };

import { sql } from '@vercel/postgres';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user?.email) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { title, messages } = await req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages required' });
    }

    // Ensure the user exists (upsert by email) and fetch id
    const userRes = await sql`
      INSERT INTO users (email, password_hash)
      VALUES (${session.user.email}, NULL)
      ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
      RETURNING id
    `;
    const userId = userRes.rows[0].id;

    // Insert conversation
    const convRes = await sql`
      INSERT INTO conversations (user_id, title, messages)
      VALUES (${userId}, ${title || null}, ${JSON.stringify(messages)}::jsonb)
      RETURNING id
    `;

    return res.status(200).json({ ok: true, id: convRes.rows[0].id });
  } catch (err) {
    console.error('save conversation error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
