// pages/api/conversations/list.js
import { sql } from "@vercel/postgres";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.id) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const userId = session.user.id;
    const { rows } = await sql`
      SELECT id, title, created_at
      FROM conversations
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT 200
    `;
    const conversations = rows.map((r) => ({ id: r.id, title: r.title, created_at: r.created_at }));
    if (!conversations || conversations.length === 0) {
      return res.status(200).json({ conversations: [] });
    }
    return res.status(200).json({ conversations });
  } catch (err) {
    console.error("GET /api/conversations/list error", err);
    return res.status(500).json({ error: "Server error" });
  }
}
