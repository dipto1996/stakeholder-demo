// pages/api/vault/upload-url.js
import { getServerSession } from "next-auth/next";
import authOptions from "../auth/[...nextauth]";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const REGION = process.env.AWS_REGION;
const BUCKET = process.env.S3_BUCKET;
const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");
  const { filename, mime } = req.body || {};
  if (!filename) return res.status(400).json({ error: "Missing filename" });

  const key = `vault/${session.user.email}/${Date.now()}_${filename.replace(/\s+/g, "_")}`;
  try {
    const putCmd = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: mime || "application/octet-stream",
      ACL: "private",
    });
    const url = await getSignedUrl(s3, putCmd, { expiresIn: 900 }); // 15 minutes
    return res.status(200).json({ uploadUrl: url, storageKey: key });
  } catch (err) {
    console.error("upload-url err", err);
    return res.status(500).json({ error: err.message || "Could not create upload url" });
  }
}
