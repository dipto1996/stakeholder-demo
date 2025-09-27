// pages/api/vault/[id]/download.js
import { getServerSession } from "next-auth/next";
import authOptions from "../auth/[...nextauth]";
import { sql } from "@vercel/postgres";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const BUCKET = process.env.S3_BUCKET;

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "Missing id" });

  try {
    const u = await sql`SELECT id FROM users WHERE email = ${session.user.email} LIMIT 1`;
    const userId = u?.rows?.[0]?.id;
    const r = await sql`SELECT storage_key, filename FROM vault_files WHERE id = ${id} AND user_id = ${userId} LIMIT 1`;
    const file = r?.rows?.[0];
    if (!file) return res.status(404).json({ error: "Not found" });

    const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: file.storage_key });
    const url = await getSignedUrl(s3, getCmd, { expiresIn: 900 }); // 15 minutes
    return res.status(200).json({ url, filename: file.filename });
  } catch (err) {
    console.error("vault download err", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
