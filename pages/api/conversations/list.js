// Returns latest conversations for the signed-in user.
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';
import { sql } from '@vercel/postgres';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

  try {
    const session = await getServerSession({ req, ...authOptions });
    if (!session?.user?.email) return new Response('Unauthorized', { status: 401 });

    const { rows: userRows } = await sql`SELECT id FROM users WHERE email = ${session.user.email} LIMIT 1`;
    if (userRows.length === 0) return new Response(JSON.stringify([]), { status: 200 });

    const userId = userRows[0].id;

    const { rows } = await sql`
      SELECT id, title, created_at
      FROM conversations
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT 25
    `;

    return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('list conversations error:', e);
    return new Response('Internal Server Error', { status: 500 });
  }
}
