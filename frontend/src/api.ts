import axios from 'axios';

const TOKEN_KEY = 'apiToken';

// Secret-link bootstrap (SEC-1): if the app was opened via …/?k=<secret>, persist the
// token and strip it from the URL so it doesn't linger in the address bar / history.
// The backend /api gate (index.ts) checks `Authorization: Bearer <API_SECRET>` only when
// API_SECRET is set on the server — so until the owner sets it, this is a harmless no-op.
try {
  const url = new URL(window.location.href);
  const k = url.searchParams.get('k');
  if (k) {
    localStorage.setItem(TOKEN_KEY, k);
    url.searchParams.delete('k');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  }
} catch { /* non-browser / malformed URL — ignore */ }

export const api = axios.create({ baseURL: '/api' });

// Attach the stored token (if any) to every request.
api.interceptors.request.use(cfg => {
  const t = localStorage.getItem(TOKEN_KEY);
  if (t) cfg.headers.set('Authorization', `Bearer ${t}`);
  return cfg;
});

// On 401 (missing/invalid token once the server gate is enabled) notify the app so it can
// show a friendly "no access" screen instead of a broken/empty UI.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }
api.interceptors.response.use(
  r => r,
  err => {
    if (err?.response?.status === 401) onUnauthorized?.();
    return Promise.reject(err);
  },
);
