// pages/api/vault/upload-url.js
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const config = { runtime: "edge" }; // optional depending on your setup

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
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  try {
    const { filename, contentType = "application/octet-stream", keyPrefix = "" } = await req.json();
    if (!filename) return res.status(400).json({ error: "Missing filename" });

    const key = `${keyPrefix}${Date.now()}-${filename}`;

    const cmd = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
    });

    const url = await getSignedUrl(s3, cmd, { expiresIn: 60 * 5 }); // 5 minutes

    return res.status(200).json({ uploadUrl: url, key });
  } catch (err) {
    console.error("upload-url error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
}
