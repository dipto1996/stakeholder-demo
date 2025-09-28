// pages/login.js
import { signIn, useSession } from "next-auth/react";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/router";

export default function LoginPage() {
  const [mode, setMode] = useState("signin"); // 'signin' | 'signup'
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState("");
  const { data: session, status } = useSession();
  const router = useRouter();
  const pollRef = useRef(null);

  useEffect(() => {
    // If session is authenticated, go to home
    if (status === "authenticated") {
      router.replace("/");
    }
  }, [status, router]);

  // Signup via your backend endpoint (unchanged)
  async function onSignup(e) {
    e.preventDefault();
    setMsg("");
    try {
      const resp = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, confirm }),
      });
      if (resp.ok) {
        setMsg("Check your email to verify your account.");
        setMode("signin");
      } else {
        const { error } = await resp.json().catch(() => ({ error: "Error" }));
        setMsg(error || "Signup failed");
      }
    } catch (err) {
      setMsg("Signup failed");
      console.error(err);
    }
  }

  // Credential sign-in (unchanged)
  async function onSignin(e) {
    e.preventDefault();
    setMsg("");
    try {
      const res = await signIn("credentials", {
        redirect: false,
        email,
        password,
      });
      if (res?.error) {
        setMsg(res.error);
      } else {
        // redirect locally after credentials signin
        window.location.href = "/";
      }
    } catch (err) {
      setMsg("Sign in failed");
      console.error(err);
    }
  }

  // Robust Google sign in: call signIn with callbackUrl and also poll for session as a fallback.
  async function handleGoogleSignIn(e) {
    e?.preventDefault();
    setMsg("");
    try {
      // Start the sign-in redirect request. Provider will normally redirect the browser.
      // Provide an explicit callbackUrl to tell provider where to return.
      await signIn("google", { callbackUrl: "/" });

      // If provider redirects correctly, this page will unload.
      // But sometimes (popup, blocked cookies), redirect can fail — start a fallback poll.
      let attempts = 0;
      const maxAttempts = 12; // ~12 * 800ms = ~9.6s
      if (pollRef.current) clearInterval(pollRef.current);

      pollRef.current = setInterval(async () => {
        attempts++;
        try {
          const resp = await fetch("/api/auth/session");
          if (resp.ok) {
            const body = await resp.json().catch(() => null);
            if (body && body.user) {
              clearInterval(pollRef.current);
              pollRef.current = null;
              // Redirect to home now that session exists
              router.replace("/");
            }
          }
        } catch (e) {
          // ignore transient fetch errors
        }
        if (attempts >= maxAttempts) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          // Provide user guidance
          setMsg(
            "Sign-in may have completed in another tab. If you are signed in, open the home page or try again. (If this keeps happening, try in a private window.)"
          );
        }
      }, 800);
    } catch (err) {
      console.error("Google sign-in error:", err);
      setMsg("Google sign-in failed. Try again or in a private window.");
    }
  }

  // cleanup poll on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  return (
    <div style={{ maxWidth: 420, margin: "60px auto", fontFamily: "Inter, system-ui, sans-serif" }}>
      <h2>{mode === "signup" ? "Create account" : "Sign in"}</h2>
      <p style={{ color: "#666" }}>Use Google or email/password.</p>

      <button
        onClick={handleGoogleSignIn}
        style={{ width: "100%", marginBottom: 12, padding: 10, borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
      >
        Continue with Google
      </button>

      <div style={{ textAlign: "center", color: "#999", margin: "12px 0" }}>or</div>

      <form onSubmit={mode === "signup" ? onSignup : onSignin} style={{ display: "grid", gap: 10 }}>
        <input
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
        />
        <input
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
        />
        {mode === "signup" && (
          <input
            placeholder="Confirm password"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
          />
        )}
        <button type="submit" style={{ padding: 10, borderRadius: 8, background: "#0b63d8", color: "#fff", border: "none", cursor: "pointer" }}>
          {mode === "signup" ? "Create account" : "Sign in"}
        </button>
      </form>

      {msg && <div style={{ marginTop: 12, color: "#444" }}>{msg}</div>}

      <div style={{ marginTop: 16, color: "#666" }}>
        {mode === "signup" ? (
          <>
            Already have an account? <a href="#" onClick={() => setMode("signin")}>Sign in</a>
          </>
        ) : (
          <>
            New here? <a href="#" onClick={() => setMode("signup")}>Create an account</a>
          </>
        )}
      </div>
    </div>
  );
}
