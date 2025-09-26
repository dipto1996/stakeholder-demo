// pages/api/auth/signup.js
import { sql } from '@vercel/postgres';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export const config = { runtime: 'nodejs' };

async function sendVerificationEmail({ to, token }) {
  const verifyUrl = `${process.env.NEXTAUTH_URL}/api/auth/verify?token=${encodeURIComponent(token)}`;
  // Resend minimal fetch (no SDK needed)
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to,
      subject: 'Verify your email',
      html: `<p>Click to verify your email:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`
    })
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { email, password, confirm } = req.body || {};
  const cleanEmail = (email || '').toLowerCase().trim();
  if (!cleanEmail || !password || password !== confirm) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const hash = await bcrypt.hash(password, 10);

  // create or upsert user (keep existing if already there but not verified)
  const { rows } = await sql`
    INSERT INTO users (email, password_hash, email_verified)
    VALUES (${cleanEmail}, ${hash}, false)
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
    RETURNING id, email
  `;
  const user = rows[0];

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24); // 24h

  await sql`
    INSERT INTO email_verification_tokens (token, user_id, expires)
    VALUES (${token}, ${user.id}, ${expires})
    ON CONFLICT (token) DO NOTHING
  `;

  await sendVerificationEmail({ to: user.email, token });

  return res.status(200).json({ ok: true });
}
