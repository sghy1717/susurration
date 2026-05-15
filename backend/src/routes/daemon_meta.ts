// Phase 16 — Daemon metadata endpoints (latest npm version etc).
//
// GET /daemon/latest-version returns the latest published version of
// susurration-agent-daemon on npm. Used by web dashboard to compare against
// identity.last_daemon_version (reported via SSE User-Agent) and show the
// upgrade banner when caller's daemon is behind.
//
// Implementation: lazy fetch npm registry on first request, cache 1h
// in-process. fly machine restart resets cache (acceptable — npm registry
// is fast enough that cache miss is ~200ms).

import { Hono } from "hono";

export const daemonMetaRoutes = new Hono();

const CACHE_TTL_MS = 60 * 60 * 1000;  // 1h
let cached: { version: string; at: number } | null = null;

daemonMetaRoutes.get("/daemon/latest-version", async (c) => {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    c.header("Cache-Control", "public, max-age=300");  // browsers cache 5min
    return c.json({ version: cached.version, cached: true });
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5_000);
    const resp = await fetch("https://registry.npmjs.org/susurration-agent-daemon/latest", {
      headers: { "Accept": "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!resp.ok) {
      // npm down: return previous cache if any, else surface 503 so client
      // can hide upgrade banner gracefully (don't claim "no upgrade available"
      // when we just can't tell).
      if (cached) return c.json({ version: cached.version, cached: true, stale: true });
      return c.json({ error: "npm_unreachable" }, 503);
    }
    const data = await resp.json() as { version?: string };
    if (!data.version) {
      if (cached) return c.json({ version: cached.version, cached: true, stale: true });
      return c.json({ error: "npm_no_version_field" }, 502);
    }
    cached = { version: data.version, at: Date.now() };
    c.header("Cache-Control", "public, max-age=300");
    return c.json({ version: data.version, cached: false });
  } catch (err) {
    if (cached) return c.json({ version: cached.version, cached: true, stale: true });
    return c.json({ error: "fetch_failed", message: (err as Error).message }, 503);
  }
});
