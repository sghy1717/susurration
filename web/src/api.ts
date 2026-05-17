// Web app API client. Same shape as cli/src/api.ts.
// Token persists in localStorage so the user doesn't re-sign every refresh.

const TOKEN_KEY = "susu.token";
const ADDRESS_KEY = "susu.address";

// Phase 18.2-w — v0 dashboard wrote tokens under `susu_token` /
// `susu_address` (underscores). v2 was authored with `susu.token` /
// `susu.address` (dots). When /dashboard started redirecting to
// /v2/overview, users who'd previously logged in via v0 hit v2 unauthed
// because the key didn't match. We treat the v0 keys as a read-only
// fallback + migrate-on-write so the next session sets v2 keys, then
// gradually drains the v0 ones.
const LEGACY_TOKEN_KEY = "susu_token";
const LEGACY_ADDRESS_KEY = "susu_address";

function readWithFallback(key: string, legacyKey: string): string | null {
  const v = localStorage.getItem(key);
  if (v != null) return v;
  const legacy = localStorage.getItem(legacyKey);
  if (legacy != null) {
    // Mirror v0 → v2 so subsequent reads find it under the v2 key without
    // hitting the legacy slot. Idempotent across calls.
    try { localStorage.setItem(key, legacy); } catch { /* quota / private mode */ }
  }
  return legacy;
}

export const apiBase: string =
  (import.meta as any).env?.VITE_SUSU_API_URL ?? "/api";

export interface ApiCall<T = any> {
  method?: string;
  path: string;
  body?: unknown;
  auth?: boolean;
  /** AbortSignal to forcibly cancel the underlying fetch. usePoll's
   *  client-side timeout uses this so a stalled socket actually gets
   *  released (rather than leaked while the consumer just reject's its
   *  own await). Callers without timeouts can omit. */
  signal?: AbortSignal;
}

export class ApiError extends Error {
  constructor(public status: number, public body: any, public path: string) {
    super(`HTTP ${status} ${path}: ${typeof body === "object" ? JSON.stringify(body) : body}`);
  }
}

export async function api<T = any>(call: ApiCall<T>): Promise<T> {
  const url = apiBase.replace(/\/$/, "") + call.path;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (call.auth !== false) {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) headers.authorization = `Bearer ${t}`;
  }
  const resp = await fetch(url, {
    method: call.method ?? "GET",
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
    signal: call.signal,
  });
  const ct = resp.headers.get("content-type") ?? "";
  const body: any = ct.includes("application/json") ? await resp.json() : await resp.text();
  if (!resp.ok) throw new ApiError(resp.status, body, call.path);
  return body as T;
}

export const session = {
  get token(): string | null { return readWithFallback(TOKEN_KEY, LEGACY_TOKEN_KEY); },
  get address(): string | null { return readWithFallback(ADDRESS_KEY, LEGACY_ADDRESS_KEY); },
  set(token: string, address: string) {
    // If the incoming token belongs to a different identity than what's in
    // storage, drop every persisted snapshot so the new user's first paint
    // doesn't briefly show the previous user's data. Same-identity logins
    // (token refresh) skip the wipe.
    const prevAddress = localStorage.getItem(ADDRESS_KEY) ?? localStorage.getItem(LEGACY_ADDRESS_KEY);
    const identityChanged = prevAddress != null && prevAddress !== address;

    // Write to both key shapes so users bouncing between v0 (/v0/dashboard
    // escape hatch) and v2 stay logged in either way during the transition.
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(ADDRESS_KEY, address);
    try {
      localStorage.setItem(LEGACY_TOKEN_KEY, token);
      localStorage.setItem(LEGACY_ADDRESS_KEY, address);
    } catch { /* quota */ }

    if (identityChanged) {
      try {
        const mod = (window as any).__susuClearPollCache;
        if (typeof mod === "function") mod();
      } catch { /* never fatal */ }
    }
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ADDRESS_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem(LEGACY_ADDRESS_KEY);
    // Drop the v2 SWR cache so re-signing in (or a different account)
    // doesn't briefly render someone else's data.
    try {
      // Lazy import to avoid circular dependency at module-load time.
      const mod = (window as any).__susuClearPollCache;
      if (typeof mod === "function") mod();
    } catch { /* never fatal */ }
  },
};
