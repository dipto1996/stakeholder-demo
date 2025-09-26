// pages/api/auth/verify.js
import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  const token = req.query.token;
  if (!token) return res.status(400).send('Missing token');

  const { rows } = await sql`
    SELECT evt.user_id, evt.expires
    FROM email_verification_tokens evt
    WHERE evt.token = ${token} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return res.status(400).send('Invalid token');
  if (new Date(row.expires) < new Date()) return res.status(400).send('Token expired');

  await sql`UPDATE users SET email_verified = true WHERE id = ${row.user_id}`;
  await sql`DELETE FROM email_verification_tokens WHERE token = ${token}`;

  // redirect back to home (signed-out state; user can now log in)
  res.writeHead(302, { Location: '/' });
  res.end();
}
