// pages/api/conversations/[id].js
import { sql } from "@vercel/postgres";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";

export default async function handler(req, res) {
  const { id } = req.query;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.id) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const userId = session.user.id;
    const { rows } = await sql`
      SELECT id, title, messages, created_at
      FROM conversations
      WHERE id = ${id} AND user_id = ${userId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    // Ensure messages is an array
    const messages = row.messages || [];
    return res.status(200).json({ id: row.id, title: row.title, messages, created_at: row.created_at });
  } catch (err) {
    console.error("GET /api/conversations/[id] error", err);
    return res.status(500).json({ error: "Server error" });
  }
}
