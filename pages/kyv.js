// pages/kyv.js
import { useState } from "react";
import { useSession } from "next-auth/react";

export default function KYVPage() {
  const { data: session } = useSession();
  const [form, setForm] = useState({
    education_level: "",
    experience_years: 0,
    exceptional_skill: false,
    country: "",
    goal: "work",
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function submit(e) {
    e?.preventDefault();
    setLoading(true);
    try {
      const r = await fetch("/api/kyv/evaluate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const d = await r.json();
      setResult(d.result || null);
    } catch (err) {
      console.error(err);
      alert("Error evaluating");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 20, maxWidth: 800, margin: "0 auto" }}>
      <h2>Know Your Visa (Beta)</h2>
      <form onSubmit={submit} style={{ display: "grid", gap: 8 }}>
        <label>
          Country of citizenship
          <input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
        </label>

        <label>
          Education level
          <input value={form.education_level} onChange={(e) => setForm({ ...form, education_level: e.target.value })} placeholder="Bachelors, Masters, PhD" />
        </label>

        <label>
          Years of professional experience
          <input type="number" value={form.experience_years} onChange={(e) => setForm({ ...form, experience_years: Number(e.target.value) })} />
        </label>

        <label>
          Exceptional skill or awards?
          <input type="checkbox" checked={form.exceptional_skill} onChange={(e) => setForm({ ...form, exceptional_skill: e.target.checked })} />
        </label>

        <label>
          Goal
          <select value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })}>
            <option value="work">Work/Employment</option>
            <option value="study">Study</option>
            <option value="invest">Invest/Other</option>
          </select>
        </label>

        <div>
          <button disabled={loading} type="submit">{loading ? "Checking..." : "Get recommendation"}</button>
        </div>
      </form>

      {result && (
        <div style={{ marginTop: 16 }}>
          <h3>Recommendation</h3>
          <pre style={{ background: "#f6f8fa", padding: 12 }}>{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
