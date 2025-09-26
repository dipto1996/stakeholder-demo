// Saves the latest conversation for the signed-in user.
// Expects: { messages, title? }
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';
import { sql } from '@vercel/postgres';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    // Need user session
    const session = await getServerSession({ req, ...authOptions });
    if (!session?.user?.email) return new Response('Unauthorized', { status: 401 });

    const { messages, title } = await req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response('messages required', { status: 400 });
    }

    // Find (or create) the user
    const userRes = await sql`
      INSERT INTO users (email)
      VALUES (${session.user.email})
      ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
      RETURNING id
    `;
    const userId = userRes.rows[0].id;

    // Default title = first user message (trimmed)
    const derivedTitle =
      title ||
      (messages.find(m => m.role === 'user')?.content || 'Conversation')
        .slice(0, 80);

    await sql`
      INSERT INTO conversations (user_id, title, messages, created_at)
      VALUES (${userId}, ${derivedTitle}, ${JSON.stringify(messages)}::jsonb, now())
    `;

    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('save conversation error:', e);
    return new Response('Internal Server Error', { status: 500 });
  }
}
