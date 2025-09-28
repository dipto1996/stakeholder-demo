// pages/api/conversations/save.js
import { sql } from "@vercel/postgres";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.id) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const userId = session.user.id;
    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.messages)) {
      return res.status(400).json({ error: "Invalid payload: messages array required" });
    }

    const convId = body.id || null;
    const title = body.title || (body.messages?.[0]?.content?.slice(0, 120) || "Conversation");
    const messages = body.messages;

    if (convId) {
      // Update existing conversation (if it belongs to user)
      const { rows: found } = await sql`SELECT id FROM conversations WHERE id = ${convId} AND user_id = ${userId} LIMIT 1`;
      if (!found || found.length === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      await sql`
        UPDATE conversations
        SET title = ${title}, messages = ${JSON.stringify(messages)}, created_at = now()
        WHERE id = ${convId} AND user_id = ${userId}
      `;
      return res.status(200).json({ id: convId, message: "updated" });
    } else {
      // Insert
      const { rows } = await sql`
        INSERT INTO conversations (user_id, title, messages, created_at)
        VALUES (${userId}, ${title}, ${JSON.stringify(messages)}, now())
        RETURNING id
      `;
      const id = rows?.[0]?.id;
      return res.status(200).json({ id, message: "inserted" });
    }
  } catch (err) {
    console.error("POST /api/conversations/save error", err);
    return res.status(500).json({ error: "Server error" });
  }
}
