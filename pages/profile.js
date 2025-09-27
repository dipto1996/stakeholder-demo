// pages/profile.js
import { useEffect, useState } from "react";
import { useSession, signIn } from "next-auth/react";

export default function ProfilePage() {
  const { data: session } = useSession();
  const [user, setUser] = useState(null);
  const [form, setForm] = useState({ name: "", avatar_url: "", bio: "", timezone: "" });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!session) return;
    fetch("/api/user/me")
      .then((r) => r.json())
      .then((d) => {
        setUser(d.user);
        setForm({
          name: d.user?.name || "",
          avatar_url: d.user?.avatar_url || "",
          bio: d.user?.bio || "",
          timezone: d.user?.timezone || "",
        });
      })
      .catch(console.error);
  }, [session]);

  if (!session) {
    return (
      <div style={{ padding: 20 }}>
        <h3>Please sign in to view your profile</h3>
        <button onClick={() => signIn()}>Sign in</button>
      </div>
    );
  }

  async function save(e) {
    e?.preventDefault();
    setLoading(true);
    try {
      const resp = await fetch("/api/user/me", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await resp.json();
      setUser(data.user);
      alert("Profile updated.");
    } catch (err) {
      console.error(err);
      alert("Error saving profile");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 20, maxWidth: 800, margin: "0 auto" }}>
      <h2>Profile</h2>
      <form onSubmit={save} style={{ display: "grid", gap: 8 }}>
        <label>
          Email
          <div style={{ padding: 8, background: "#f6f8fa", borderRadius: 6 }}>{session.user.email}</div>
        </label>

        <label>
          Full name
          <input
            value={form.name}
            onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
            placeholder="Your name"
            style={{ width: "100%", padding: 8 }}
          />
        </label>

        <label>
          Avatar URL
          <input
            value={form.avatar_url}
            onChange={(e) => setForm((s) => ({ ...s, avatar_url: e.target.value }))}
            placeholder="https://..."
            style={{ width: "100%", padding: 8 }}
          />
        </label>

        <label>
          Short bio
          <textarea
            value={form.bio}
            onChange={(e) => setForm((s) => ({ ...s, bio: e.target.value }))}
            rows={3}
            style={{ width: "100%", padding: 8 }}
          />
        </label>

        <label>
          Timezone
          <input
            value={form.timezone}
            onChange={(e) => setForm((s) => ({ ...s, timezone: e.target.value }))}
            placeholder="America/Los_Angeles"
            style={{ width: "100%", padding: 8 }}
          />
        </label>

        <div>
          <button type="submit" disabled={loading} style={{ padding: "8px 12px", borderRadius: 6 }}>
            {loading ? "Saving..." : "Save profile"}
          </button>
        </div>
      </form>

      {user?.avatar_url && (
        <div style={{ marginTop: 12 }}>
          <img src={user.avatar_url} alt="avatar" style={{ width: 96, height: 96, borderRadius: 8 }} />
        </div>
      )}
    </div>
  );
}
