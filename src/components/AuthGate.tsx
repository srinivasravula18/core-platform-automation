import React, { useEffect, useState } from 'react';
import { BrainCircuit, Lock, Loader2, Eye, EyeOff } from 'lucide-react';
import { readScopedStorage, writeScopedStorage } from '@/src/lib/storage';

const TOKEN_KEY = 'tfa_auth_token';
const USERNAME_KEY = 'tfa_username';
const ROLE_KEY = 'tfa_role';

export function getAuthToken(): string {
  return readScopedStorage(TOKEN_KEY) || '';
}

export function getUsername(): string {
  return readScopedStorage(USERNAME_KEY) || '';
}

export function getRole(): 'admin' | 'tester' | '' {
  const r = readScopedStorage(ROLE_KEY);
  return r === 'admin' || r === 'tester' ? r : '';
}

export function isAdmin(): boolean {
  return getRole() === 'admin';
}

export function logout() {
  try {
    const token = getAuthToken();
    if (token) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    writeScopedStorage(TOKEN_KEY, null);
    writeScopedStorage(USERNAME_KEY, null);
    writeScopedStorage(ROLE_KEY, null);
  } catch {
    /* ignore */
  }
  window.location.reload();
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<'checking' | 'out' | 'in'>('checking');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Validate any stored token on load.
  useEffect(() => {
    const token = getAuthToken();
    if (!token) {
      setStatus('out');
      return;
    }
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (r.ok) {
          const me = await r.json().catch(() => ({}));
          if (me?.role) writeScopedStorage(ROLE_KEY, me.role);
          if (me?.username) writeScopedStorage(USERNAME_KEY, me.username);
          setStatus('in');
        } else {
          writeScopedStorage(TOKEN_KEY, null);
          setStatus('out');
        }
      })
      .catch(() => setStatus('out'));
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || 'Login failed. Please try again.');
        setSubmitting(false);
        return;
      }
      writeScopedStorage(TOKEN_KEY, data.token);
      writeScopedStorage(USERNAME_KEY, (data.username || username).trim());
      if (data.role) writeScopedStorage(ROLE_KEY, data.role);
      setStatus('in');
    } catch {
      setError('Could not reach the server. Please try again.');
      setSubmitting(false);
    }
  };

  if (status === 'checking') {
    return (
      <div className="flex h-[100dvh] w-full items-center justify-center bg-[var(--bg-primary)] text-[var(--text-muted)]">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (status === 'in') {
    return <>{children}</>;
  }

  return (
    <div className="flex h-[100dvh] w-full items-center justify-center bg-[var(--bg-primary)] p-4 font-sans text-[var(--text-primary)]">
      <div className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-8 shadow-xl">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--accent)]/10">
            <BrainCircuit className="h-7 w-7 text-[var(--accent)]" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">Test Flow AI</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Sign in to continue</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Username</label>
            <input
              type="text"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              autoComplete="username"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm outline-none transition-colors placeholder-[var(--text-muted)] focus:border-[var(--accent)]"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Password</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 pr-10 text-sm outline-none transition-colors placeholder-[var(--text-muted)] focus:border-[var(--accent)]"
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                title={showPassword ? 'Hide password' : 'Show password'}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
            {submitting ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
