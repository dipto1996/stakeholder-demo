// pages/vault.js
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";

export default function VaultPage() {
  const { data: session } = useSession();
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!session) return;
    load();
  }, [session]);

  async function load() {
    const r = await fetch("/api/vault/list");
    const d = await r.json();
    setFiles(d.files || []);
  }

  async function handleFileChange(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!confirm(`Upload ${f.name}?`)) return;
    setUploading(true);
    try {
      // request upload url
      const metaResp = await fetch("/api/vault/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: f.name, mime: f.type }),
      });
      const meta = await metaResp.json();
      // upload directly to S3
      await fetch(meta.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": f.type },
        body: f,
      });
      // complete
      await fetch("/api/vault/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: f.name, storageKey: meta.storageKey, mime: f.type, size: f.size }),
      });
      await load();
      alert("Uploaded");
    } catch (err) {
      console.error(err);
      alert("Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function download(id) {
    const r = await fetch(`/api/vault/${id}/download`);
    const d = await r.json();
    if (d.url) window.open(d.url, "_blank");
  }

  return (
    <div style={{ padding: 20 }}>
      <h2>Vault</h2>

      <div style={{ marginBottom: 12 }}>
        <input type="file" onChange={handleFileChange} disabled={uploading} />
      </div>

      <div>
        <h3>Your files</h3>
        <div style={{ display: "grid", gap: 8 }}>
          {files.length === 0 && <div>No files</div>}
          {files.map((f) => (
            <div key={f.id} style={{ padding: 10, border: "1px solid #eee", borderRadius: 6, display: "flex", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 700 }}>{f.filename}</div>
                <div style={{ fontSize: 12, color: "#666" }}>{new Date(f.created_at).toLocaleString()}</div>
              </div>
              <div>
                <button onClick={() => download(f.id)}>Download</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
