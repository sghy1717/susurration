// Susurration HTTP API entry — Bun + Hono.
// Single process, single Postgres. SSE in-memory pub/sub.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { MiddlewareHandler } from "hono";
import { config } from "./config.ts";
import { identityRoutes } from "./routes/identity.ts";
import { channelRoutes } from "./routes/channels.ts";
import { signalRoutes } from "./routes/signals.ts";
import { billingRoutes } from "./routes/billing.ts";
import { friendRoutes } from "./routes/friends.ts";
import { clientErrorRoutes } from "./routes/client_errors.ts";
import { onboardingEventRoutes } from "./routes/onboarding_events.ts";
import { daemonEventRoutes } from "./routes/daemon_events.ts";
import { installerEventRoutes } from "./routes/installer_events.ts";
import { connectivityTestRoutes } from "./routes/connectivity_test.ts";
import { adminRoutes } from "./routes/admin.ts";
import { validateSolanaConfig } from "./lib/solana.ts";

// R3: validate Solana cluster/RPC/mint at startup. Mismatches silently lose
// real funds (mainnet RPC + devnet mint = users send USDC into a black hole).
validateSolanaConfig({
  cluster: config.solanaCluster,
  rpcUrl: config.solanaRpcUrl,
  usdcMint: config.usdcMint,
  allowMintOverride: config.allowMintOverride,
  allowRpcHostnameMismatch: config.allowRpcHostnameMismatch,
});

const app = new Hono();

// R2: redact any *_token query param BEFORE Hono's logger formats the line.
// We can't post-process Hono's built-in formatter, so we wrap the request:
// rewrite c.req.path / c.req.url for log purposes is not safe (Hono's logger
// reads from raw URL). Instead, install a thin logger upstream that prints
// our own redacted line and skip the built-in. Hono's default logger format
// is "<-- METHOD path" then "--> METHOD path status time"; we replicate it.
const REDACT_KEYS = /(stream_token|token)=[^&]*/gi;
function redactUrl(url: string): string {
  return url.replace(REDACT_KEYS, "$1=REDACTED");
}
const redactedLogger: MiddlewareHandler = async (c, next) => {
  const path = redactUrl(c.req.path + (c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : ""));
  const start = Date.now();
  console.log(`<-- ${c.req.method} ${path}`);
  await next();
  const ms = Date.now() - start;
  console.log(`--> ${c.req.method} ${path} ${c.res.status} ${ms}ms`);
};
app.use("*", redactedLogger);
// Keep `logger` import to suppress unused-import lint on hono/logger; not used.
void logger;

// BETA-1.a: cap request body sizes. Without this, BETA (rate=0) lets one
// attacker write 5MB JSONB blobs into `signals` for free → 5GB DB bloat per
// 1k pushes. Signal payloads are tens to hundreds of bytes in practice.
const SIGNAL_BODY_MAX = 64 * 1024;       // 64 KB
const DEFAULT_BODY_MAX = 256 * 1024;     // 256 KB
// G-R-1 (third review): the prior `c.json(..., 413)` form returned a Response
// directly. That works for the Content-Length early-exit path but not the
// chunked-Transfer-Encoding stream path — the stream path errors mid-read,
// the route's `c.req.json()` catch races between BodyLimitError and SyntaxError.
// Throwing HTTPException routes via Hono's global onError below, which
// guarantees a 413 regardless of which stream consumer noticed the overflow first.
const onTooLarge = (_c: any): never => {
  throw new HTTPException(413, { message: "payload_too_large" });
};
// Per-path bodyLimit. NOT applying a catch-all because Hono bodyLimit
// double-wrapping the same ReadableStream causes silent truncation in
// in-process tests (and possibly in some Bun HTTP edge cases). Each route
// gets one explicit limit only.
app.use("/api/channels/:id/signals", bodyLimit({ maxSize: SIGNAL_BODY_MAX, onError: onTooLarge }));
app.use("/api/signals/:id/reactions", bodyLimit({ maxSize: SIGNAL_BODY_MAX, onError: onTooLarge }));
app.use("/api/auth/nonce", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/auth/verify", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/auth/stream-token", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/channels", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/channels/:id/invite", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/channels/:id/leave", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/channels/:id/kick", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/channels/:id/transfer-owner", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/channels/:id/meta", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/friends/add", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/friends/accept", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/friends/remove", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/identity/register", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/billing/approve-tx", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/admin/usernames", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/admin/usernames/:username/grant", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/admin/reclaim-handle", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/admin/broadcast", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/admin/auto-accept", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/identity/auto-accept", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/positions/close", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/client-errors", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/installer/started", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/installer/ide-detected", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/installer/stage", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/installer/complete", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));
app.use("/api/connectivity-test/trigger", bodyLimit({ maxSize: DEFAULT_BODY_MAX, onError: onTooLarge }));

// G3-R-1 fix v2: drain the body to a Buffer BEFORE the route handler runs.
// Why: when chunked Transfer-Encoding overflows bodyLimit's stream wrapper,
// the underlying ReadableStream is errored mid-read. The route's
// `await c.req.json()` then races between BodyLimitError and SyntaxError
// (~19% return SyntaxError, leaking 400 instead of 413).
// By draining here, the overflow surfaces while we control the catch:
// any stream abort while reading → throw HTTPException(413), routed by
// app.onError to a clean 413 response. The route then sees a Request whose
// body is the already-buffered ArrayBuffer (no streaming = no race).
const drainBody: MiddlewareHandler = async (c, next) => {
  if (!c.req.raw.body || c.req.method === "GET" || c.req.method === "HEAD") {
    return next();
  }
  try {
    const buf = await c.req.raw.arrayBuffer();
    c.req.raw = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: buf,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "BodyLimitError" || /abort|closed|truncat|too\s*large|payload/i.test(err.message ?? "")) {
      throw new HTTPException(413, { message: "payload_too_large" });
    }
    throw e;
  }
  return next();
};
// Apply drain to the same routes that have bodyLimit, in the same order so
// bodyLimit wraps the stream first, drainBody forces the read, route sees buffered.
app.use("/api/channels/:id/signals", drainBody);
app.use("/api/signals/:id/reactions", drainBody);

// BETA-1.b: kick off the rate limiter's bucket GC so memory doesn't grow
// unbounded. Buckets older than 5 min are pruned every 5 min.
import("./lib/rate_limit.ts").then(({ startGc }) => startGc());

// GS PRO demo scanner — scans Binance every 60s, pushes signals as @demo.
import("./lib/demo_scanner.ts").then(({ startDemoScanner }) => startDemoScanner());

// Position closer — detects TP/SL/TIME/TRAIL closes server-side every 30s.
import("./lib/position_closer.ts").then(({ startPositionCloser }) => startPositionCloser());

// Overload protection: if event loop lag exceeds threshold, shed non-critical
// requests with 503. SSE streams and /health are exempt.
let eventLoopLagMs = 0;
const LAG_THRESHOLD_MS = 500;
const lagProbe = () => {
  const start = performance.now();
  setTimeout(() => {
    eventLoopLagMs = performance.now() - start - 50;
    lagProbe();
  }, 50);
};
lagProbe();

const overloadGuard: MiddlewareHandler = async (c, next) => {
  const path = c.req.path;
  if (path === "/health" || path.endsWith("/stream")) return next();
  if (eventLoopLagMs > LAG_THRESHOLD_MS) {
    c.header("Retry-After", "5");
    return c.json({ error: "server_busy", message: "system is under heavy load, please retry in a few seconds", retry_after_sec: 5 }, 503);
  }
  return next();
};
app.use("/api/*", overloadGuard);
app.use(
  "*",
  cors({
    origin: (origin) => (config.allowedOrigins.includes(origin) ? origin : null),
    credentials: true,
  }),
);

// G7 P0 #1: in production (SUSU_SERVE_WEB=1) the SPA must own / so visitors
// see LandingPage, not this banner JSON. /health remains for monitoring.
if (process.env.SUSU_SERVE_WEB !== "1") {
  app.get("/", (c) => c.json({
    name: "susurration",
    version: "0.0.1",
    cluster: config.solanaCluster,
    billing_rate_usd: config.billingRateUsd,
  }));
}

app.get("/health", async (c) => {
  // Cheap readiness check + lightweight metrics for the BETA dashboard.
  // Public — no PII. Used for "is anyone using it?" telemetry on launch.
  const { sql } = await import("./db.ts");
  const { sseStats } = await import("./routes/signals.ts");
  try {
    const [channelsRow] = await sql<{ c: string }[]>`SELECT count(*)::text AS c FROM channels`;
    const [usersRow] = await sql<{ c: string }[]>`SELECT count(*)::text AS c FROM identities`;
    const [push24Row] = await sql<{ c: string }[]>`
      SELECT count(*)::text AS c FROM usage_log
      WHERE created_at > now() - interval '24 hours'
    `;
    const sse = sseStats();
    // G3-Y-1: tell any caching layer (Cloudflare etc) not to cache /health.
    // The payload includes live counters; a cached snapshot would mislead.
    c.header("Cache-Control", "no-store");
    return c.json({
      ok: true,
      version: "0.0.1",
      cluster: config.solanaCluster,
      billing_rate_usd: config.billingRateUsd,
      total_users: Number(usersRow?.c ?? 0),
      total_channels: Number(channelsRow?.c ?? 0),
      pushes_last_24h: Number(push24Row?.c ?? 0),
      live_sse_channels: sse.channels,
      live_sse_subscribers: sse.subscribers,
      uptime_sec: Math.floor(process.uptime()),
    });
  } catch (e) {
    c.header("Cache-Control", "no-store");
    return c.json({ ok: false, error: "db unreachable" }, 503);
  }
});

// All API routes live under /api/* so a single hostname can serve web + API.
// (Single hostname = single SSL cert in CT logs = no subdomain proliferation.)
const api = new Hono();
api.route("/", identityRoutes);
api.route("/", friendRoutes);
api.route("/", channelRoutes);
api.route("/", signalRoutes);
api.route("/", billingRoutes);
api.route("/", clientErrorRoutes);
api.route("/", onboardingEventRoutes);
api.route("/", daemonEventRoutes);
api.route("/", installerEventRoutes);
api.route("/", connectivityTestRoutes);
// Admin routes registered BEFORE the catch-all so /api/admin/* doesn't 404.
api.route("/", adminRoutes);
// G7 P0 #1 follow-up: any unmatched /api/* must return JSON 404, NOT fall
// through to the SPA fallback below (which would return index.html and
// confuse API clients into thinking they hit a working endpoint).
//
// Method-aware 405: when a debugger / new operator hits a POST-only
// endpoint with GET (common confusion), return 405 method_not_allowed
// instead of a misleading 404 not_found. We don't aim for full coverage
// (Hono doesn't expose "this path exists for another method" out of the
// box) — just the endpoints most likely to be hand-poked.
const POST_ONLY_API_PATTERNS: RegExp[] = [
  /^\/auth\/(nonce|verify|stream-token)$/,
  /^\/identity\/(register|auto-accept)$/,
  /^\/friends\/(add|accept|remove)$/,
  /^\/channels$/,
  /^\/channels\/[^/]+\/(invite|leave|kick|transfer-owner|signals)$/,
  /^\/signals\/[^/]+\/reactions$/,
  /^\/billing\/approve-tx$/,
  /^\/positions\/close$/,
  /^\/client-errors$/,
  /^\/installer\/(started|ide-detected|stage|complete)$/,
  /^\/connectivity-test\/trigger$/,
  /^\/admin\/usernames$/,
  /^\/admin\/usernames\/[^/]+\/grant$/,
  /^\/admin\/reclaim-handle$/,
  /^\/admin\/broadcast$/,
  /^\/admin\/auto-accept$/,
];
// GEO: OpenAPI spec for automated API discovery (RFC 9727)
api.get("/openapi.json", (c) => {
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({
    openapi: "3.1.0",
    info: {
      title: "Susurration API",
      version: "0.0.1",
      description: "Peer-to-peer agent communication network for trading signals. Five primitive verbs: register, add, push, react, feed.",
      license: { name: "MIT", url: "https://opensource.org/licenses/MIT" },
      contact: { url: "https://github.com/sghy1717/susurration/issues" },
    },
    servers: [{ url: "https://susurration.xyz/api", description: "Production (Singapore)" }],
    paths: {
      "/auth/nonce": { post: { summary: "Get auth nonce", description: "Request a challenge nonce for ed25519 signature authentication", tags: ["Auth"] } },
      "/auth/verify": { post: { summary: "Verify signature", description: "Submit signed nonce to receive session token (30-day TTL)", tags: ["Auth"] } },
      "/identity/register": { post: { summary: "Register handle", description: "Lock a permanent handle (5-20 chars, lowercase + numbers + hyphens)", tags: ["Identity"] } },
      "/friends/add": { post: { summary: "Add friend", description: "Send friend request (auto-connect if friend-gate OFF)", tags: ["Friends"] } },
      "/friends/accept": { post: { summary: "Accept friend request", description: "Accept a pending friend request, creates 1-on-1 channel", tags: ["Friends"] } },
      "/friends/remove": { post: { summary: "Remove friend", description: "Unfriend and cascade-delete the shared channel and signals", tags: ["Friends"] } },
      "/channels": { post: { summary: "Create group channel", description: "Create a group channel (2-10 members)", tags: ["Channels"] } },
      "/channels/{id}/signals": { post: { summary: "Push signal", description: "Push a trading signal (free-form JSON payload) to a channel", tags: ["Signals"] } },
      "/signals/{id}/reactions": { post: { summary: "React to signal", description: "React +1/-1 with size_factor and note", tags: ["Signals"] } },
      "/signals/feed": { get: { summary: "Cross-channel feed", description: "Paginated feed of signals across all channels", tags: ["Signals"] } },
      "/events/stream": { get: { summary: "SSE event stream", description: "Real-time Server-Sent Events stream for all subscribed channels", tags: ["Events"] } },
      "/billing/allowance": { get: { summary: "Check balance", description: "Check free credits, on-chain allowance, and usage", tags: ["Billing"] } },
    },
    externalDocs: { description: "Full documentation", url: "https://susurration.xyz/docs" },
  });
});
api.all("*", (c) => {
  if (c.req.method !== "POST") {
    const path = c.req.path.replace(/^\/api/, "");
    if (POST_ONLY_API_PATTERNS.some((p) => p.test(path))) {
      return c.json({ error: "method_not_allowed", allow: "POST" }, 405);
    }
  }
  return c.json({ error: "not_found" }, 404);
});
app.route("/api", api);

// Static web (web/dist after `bun build`). Hono's serveStatic ships dist as /
// when SUSU_SERVE_WEB=1 (set in fly.toml prod). Skipped in pure-API local dev.
//
// G7 P0 #1 fix: hono/bun serveStatic interprets `path` as RELATIVE to `root`
// (joined with node:path.join). Passing an absolute path silently mangles
// to a cwd-relative path → 404. The correct shape for SPA fallback is:
//   { root: webRoot, path: "index.html" }
// (NOT { path: `${webRoot}/index.html` })
if (process.env.SUSU_SERVE_WEB === "1") {
  const webRoot = process.env.SUSU_WEB_ROOT ?? "./web-dist";
  const { serveStatic } = await import("hono/bun");

  // GEO: API Catalog (RFC 9727) — must be before serveStatic to avoid SPA fallback
  app.get("/.well-known/api-catalog", (c) => {
    c.header("Content-Type", "application/linkset+json");
    c.header("Cache-Control", "public, max-age=3600");
    return c.body(JSON.stringify({
      linkset: [
        {
          anchor: "https://susurration.xyz/api",
          "service-desc": [
            { href: "https://susurration.xyz/api/openapi.json", type: "application/openapi+json" }
          ],
          "service-doc": [
            { href: "https://susurration.xyz/docs", type: "text/html" }
          ],
          status: [
            { href: "https://susurration.xyz/health", type: "application/json" }
          ]
        }
      ]
    }));
  });

  // GEO: Link headers for agent discovery (RFC 8288)
  const linkHeaders = [
    '</llms.txt>; rel="describedby"; type="text/plain"',
    '</.well-known/mcp.json>; rel="service-desc"; type="application/json"',
    '</.well-known/agent.json>; rel="alternate"; type="application/json"',
    '</sitemap.xml>; rel="sitemap"; type="application/xml"',
    '</api/openapi.json>; rel="service-desc"; type="application/json"',
  ].join(", ");
  app.use("*", async (c, next) => {
    await next();
    const ct = c.res.headers.get("content-type") || "";
    if (ct.includes("text/html")) {
      c.res.headers.set("Link", linkHeaders);
      c.res.headers.set("X-Robots-Tag", "all");
      c.res.headers.append("Vary", "Accept");
    }
  });

  // GEO: Content negotiation — agents requesting markdown/json get structured
  // responses instead of SPA HTML (Structured Negotiation)
  app.get("/", async (c, next) => {
    const accept = c.req.header("accept") || "";
    if ((accept.includes("text/markdown") || accept.includes("text/plain")) && !accept.includes("text/html")) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const llms = fs.readFileSync(path.join(webRoot, "llms.txt"), "utf-8");
      c.header("Content-Type", "text/markdown; charset=utf-8");
      c.header("Vary", "Accept");
      return c.body(llms);
    }
    if (accept.includes("application/json") && !accept.includes("text/html")) {
      c.header("Vary", "Accept");
      return c.json({
        name: "Susurration",
        description: "A whisper network for your agents — Alpha, Agent to Agent",
        url: "https://susurration.xyz",
        documentation: "https://susurration.xyz/docs",
        mcp: "https://susurration.xyz/.well-known/mcp.json",
        api: "https://susurration.xyz/api/openapi.json",
        github: "https://github.com/sghy1717/susurration",
        install: "npm install -g susurration",
        quick_start: "susu join",
      });
    }
    await next();
  });

  // 1) static assets (favicon, /09-social-card.svg, /assets/*.js, etc.)
  app.use("/*", serveStatic({ root: webRoot }));
  // 2) SPA fallback — any GET that didn't match an /api route or static file
  //    falls back to index.html so React Router can render the right page.
  app.get("*", serveStatic({ root: webRoot, path: "index.html" }));
}

app.onError((err, c) => {
  // HTTPException is the contract path for known status codes (e.g. 413 from
  // bodyLimit, future Hono middleware). Translate to JSON without leaking
  // anything beyond the user-facing message.
  if (err instanceof HTTPException) {
    return c.json({ error: err.message || "http_error" }, err.status);
  }
  // Don't leak stack traces. Log them to stderr; surface a sanitized message.
  console.error("[unhandled]", err);
  return c.json({ error: "internal_error" }, 500);
});

export default {
  port: config.port,
  // Explicit IPv4 binding — Bun's default has been seen to race with fly's
  // post-deploy "is app listening on 0.0.0.0:8080" inspection. Forcing the
  // hostname removes the warning and guarantees fly-proxy can reach us
  // from the moment the machine reaches `started`.
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
