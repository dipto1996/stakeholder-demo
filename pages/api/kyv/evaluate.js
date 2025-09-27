// pages/api/kyv/evaluate.js
import { getServerSession } from "next-auth/next";
import authOptions from "../auth/[...nextauth]";
import { sql } from "@vercel/postgres";

/**
 * Simple heuristic evaluator:
 * - if education >= bachelor's and experience >= 3 => H-1B strong
 * - if exceptional_skill true => O-1 candidate
 * - otherwise suggest student or other
 */
export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const body = req.body || {};
  const { education_level, experience_years, exceptional_skill, country, goal } = body;

  // simple scores
  let scores = { "H-1B": 0, "O-1": 0, "F-1": 0, "Other": 0 };

  if ((education_level || "").toLowerCase().includes("bachelor") && (experience_years || 0) >= 2) scores["H-1B"] += 60;
  if ((experience_years || 0) >= 6) scores["H-1B"] += 10;
  if (exceptional_skill) scores["O-1"] += 70;
  if ((education_level || "").toLowerCase().includes("master")) scores["H-1B"] += 10;
  if (goal === "study") scores["F-1"] += 80;

  // normalize
  const total = Object.values(scores).reduce((s) => s + 1, 0); // avoid zero division
  // store evaluation
  try {
    const u = await sql`SELECT id FROM users WHERE email = ${session.user.email} LIMIT 1`;
    const userId = u?.rows?.[0]?.id;
    const insert = await sql`
      INSERT INTO kyv_records (user_id, answers, result, created_at)
      VALUES (${userId}, ${JSON.stringify(body)}, ${JSON.stringify(scores)}, now())
      RETURNING id
    `;
    return res.status(200).json({ result: scores, record: insert.rows?.[0] || null });
  } catch (err) {
    console.error("kyv evaluate err", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
