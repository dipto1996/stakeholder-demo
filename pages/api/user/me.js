// pages/api/user/me.js
import { getServerSession } from "next-auth/next";
import { sql } from "@vercel/postgres";
import { authOptions } from "../auth/[...nextauth]";

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return res.status(401).json({ error: "Unauthorized" });

  try {
    // get the user row
    const userRow = await sql`SELECT * FROM users WHERE email = ${session.user.email} LIMIT 1`;
    const user = userRow?.rows?.[0] || null;

    if (req.method === "GET") {
      return res.status(200).json({ user });
    }

    if (req.method === "POST") {
      const { name, avatar_url, bio, timezone } = req.body || {};
      await sql`
        UPDATE users SET
          name = COALESCE(${name}, name),
          avatar_url = COALESCE(${avatar_url}, avatar_url),
          bio = COALESCE(${bio}, bio),
          timezone = COALESCE(${timezone}, timezone),
          updated_at = now()
        WHERE email = ${session.user.email}
      `;
      const updated = await sql`SELECT * FROM users WHERE email = ${session.user.email} LIMIT 1`;
      return res.status(200).json({ user: updated.rows?.[0] || null });
    }

    res.setHeader("Allow", "GET,POST");
    return res.status(405).end("Method Not Allowed");
  } catch (err) {
    console.error("api/user/me error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
