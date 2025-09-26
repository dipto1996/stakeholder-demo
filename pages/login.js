// pages/login.js
import { signIn } from 'next-auth/react';
import { useState } from 'react';

export default function LoginPage() {
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState('');

  async function onSignup(e) {
    e.preventDefault();
    setMsg('');
    const resp = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, confirm })
    });
    if (resp.ok) {
      setMsg('Check your email to verify your account.');
      setMode('signin');
    } else {
      const { error } = await resp.json().catch(() => ({ error: 'Error' }));
      setMsg(error || 'Signup failed');
    }
  }

  async function onSignin(e) {
    e.preventDefault();
    setMsg('');
    const res = await signIn('credentials', {
      redirect: false,
      email,
      password
    });
    if (res?.error) setMsg(res.error);
    else window.location.href = '/';
  }

  return (
    <div style={{ maxWidth: 420, margin: '80px auto', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <h2>{mode === 'signup' ? 'Create account' : 'Sign in'}</h2>
      <p style={{ color: '#666' }}>Use Google or email/password.</p>

      <button
        onClick={() => signIn('google')}
        style={{ width: '100%', marginBottom: 12, padding: 10, borderRadius: 8, border: '1px solid #ddd' }}
      >
        Continue with Google
      </button>

      <div style={{ textAlign: 'center', color: '#999', margin: '12px 0' }}>or</div>

      <form onSubmit={mode === 'signup' ? onSignup : onSignin} style={{ display: 'grid', gap: 10 }}>
        <input
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ padding: 10, borderRadius: 8, border: '1px solid #ddd' }}
        />
        <input
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ padding: 10, borderRadius: 8, border: '1px solid #ddd' }}
        />
        {mode === 'signup' && (
          <input
            placeholder="Confirm password"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            style={{ padding: 10, borderRadius: 8, border: '1px solid #ddd' }}
          />
        )}
        <button type="submit" style={{ padding: 10, borderRadius: 8, background: '#0b63d8', color: '#fff', border: 'none' }}>
          {mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>
      </form>

      {msg && <div style={{ marginTop: 12, color: '#444' }}>{msg}</div>}

      <div style={{ marginTop: 16, color: '#666' }}>
        {mode === 'signup' ? (
          <>Already have an account?{' '}
            <a href="#" onClick={() => setMode('signin')}>Sign in</a></>
        ) : (
          <>New here?{' '}
            <a href="#" onClick={() => setMode('signup')}>Create an account</a></>
        )}
      </div>
    </div>
  );
}
