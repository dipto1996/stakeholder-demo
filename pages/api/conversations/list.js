// pages/api/conversations/list.js
export const config = { runtime: 'nodejs' };

import { sql } from '@vercel/postgres';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user?.email) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Fetch the user’s conversations (lightweight list)
    const { rows } = await sql`
      SELECT c.id, c.title, c.created_at
      FROM conversations c
      JOIN users u ON u.id = c.user_id
      WHERE u.email = ${session.user.email}
      ORDER BY c.created_at DESC
      LIMIT 50
    `;

    return res.status(200).json({ ok: true, conversations: rows });
  } catch (err) {
    console.error('list conversations error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
