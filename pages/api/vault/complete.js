// pages/api/vault/complete.js
import { getServerSession } from "next-auth/next";
import authOptions from "../auth/[...nextauth]";
import { sql } from "@vercel/postgres";

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");
  const { filename, storageKey, mime, size } = req.body || {};
  if (!filename || !storageKey) return res.status(400).json({ error: "Missing fields" });

  try {
    // fetch user id
    const u = await sql`SELECT id FROM users WHERE email = ${session.user.email} LIMIT 1`;
    const userId = u?.rows?.[0]?.id;
    if (!userId) return res.status(400).json({ error: "User not found" });

    const insert = await sql`
      INSERT INTO vault_files (user_id, filename, storage_key, mime, size_bytes, created_at)
      VALUES (${userId}, ${filename}, ${storageKey}, ${mime || null}, ${size || null}, now())
      RETURNING *
    `;
    return res.status(200).json({ file: insert.rows?.[0] || null });
  } catch (err) {
    console.error("vault complete err", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
