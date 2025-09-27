// pages/api/vault/list.js
import { getServerSession } from "next-auth/next";
import authOptions from "../auth/[...nextauth]";
import { sql } from "@vercel/postgres";

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return res.status(401).json({ error: "Unauthorized" });

  try {
    const u = await sql`SELECT id FROM users WHERE email = ${session.user.email} LIMIT 1`;
    const userId = u?.rows?.[0]?.id;
    if (!userId) return res.status(400).json({ error: "User not found" });

    const files = await sql`SELECT id, filename, storage_key, mime, size_bytes, created_at FROM vault_files WHERE user_id = ${userId} ORDER BY created_at DESC`;
    return res.status(200).json({ files: files.rows || [] });
  } catch (err) {
    console.error("vault list err", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
