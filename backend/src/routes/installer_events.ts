// v4 — `@susurration/installer` npm package reports each install stage to
// the backend. Web onboarding step 3 subscribes to user-scope feed-stream and
// renders a real-time 4-stage progress bar driven by these events.
//
// Schema-less to mirror onboarding_events.ts. Stages are domain-defined by
// installer code:
//   stage=1 install_daemon       → npm install -g susurration-agent-daemon
//   stage=2 mount_to_ide         → claude mcp add OK + verify
//   stage=3 connect_susurration  → daemon spawn + SSE subscribe success
//   stage=4 first_signal_ready   → welcome+replay signal already in channel
//
// All endpoints fire-and-forget; always return 200 {ok:true} to not block
// installer's CLI flow.

import { Hono } from "hono";
import { authedAddress, AuthError } from "../auth.ts";
import { parseJsonBody } from "../lib/http.ts";
import { check as rateCheck, RateLimitedError } from "../lib/rate_limit.ts";
import { recordEvent } from "../lib/events.ts";

// v4: SSE push of installer stages to web is intentionally NOT implemented.
// Onboarding Step 3 was simplified to "copy command + Enter Dashboard" — the
// installer prints its 4-stage progress to the user's terminal in real time
// (where they ran the command), and Dashboard's sidebar daemon-alive indicator
// takes over once they enter. No web SSE consumer needed.

export const installerEventRoutes = new Hono();

const REPORT_LIMIT = { windowMs: 60_000, max: 60 };

async function authOptional(c: any): Promise<string | null> {
  try {
    const address = await authedAddress(c.req.header("authorization"));
    rateCheck(`installer:${address}`, REPORT_LIMIT);
    return address;
  } catch (e) {
    if (e instanceof RateLimitedError) return null;
    if (e instanceof AuthError) return null;
    return null;
  }
}

// POST /installer/started
installerEventRoutes.post("/installer/started", async (c) => {
  const address = await authOptional(c);
  const body = await parseJsonBody(c);
  if (body === null) return c.json({ ok: true }, 200);

  const version = body?.version != null ? String(body.version).slice(0, 50) : undefined;
  const node_version = body?.node_version != null ? String(body.node_version).slice(0, 50) : undefined;
  const platform = body?.platform != null ? String(body.platform).slice(0, 20) : undefined;

  recordEvent({
    type: "installer_started",
    address,
    payload: { ...(version ? { version } : {}), ...(node_version ? { node_version } : {}), ...(platform ? { platform } : {}) },
  });
  return c.json({ ok: true });
});

// POST /installer/ide-detected
installerEventRoutes.post("/installer/ide-detected", async (c) => {
  const address = await authOptional(c);
  const body = await parseJsonBody(c);
  if (body === null) return c.json({ ok: true }, 200);

  const idesRaw = Array.isArray(body?.ides) ? body.ides.slice(0, 10) : [];
  const ides = idesRaw.map((x: unknown) => String(x).slice(0, 20));

  recordEvent({ type: "installer_ide_detected", address, payload: { ides } });
  return c.json({ ok: true });
});

// POST /installer/stage — per-stage progress tick (drives the 4-stage progress bar)
installerEventRoutes.post("/installer/stage", async (c) => {
  const address = await authOptional(c);
  const body = await parseJsonBody(c);
  if (body === null) return c.json({ ok: true }, 200);

  const stage = Number(body?.stage);
  if (!Number.isFinite(stage) || stage < 1 || stage > 4) {
    return c.json({ ok: true }, 200);
  }
  const status = ["ok", "fail", "timeout", "running"].includes(String(body?.status))
    ? String(body.status) : "ok";
  const elapsed_ms = Number.isFinite(Number(body?.elapsed_ms)) ? Number(body.elapsed_ms) : null;
  const error_hint = body?.error_hint != null ? String(body.error_hint).slice(0, 200) : undefined;
  const ide = body?.ide != null ? String(body.ide).slice(0, 20) : undefined;

  recordEvent({
    type: "installer_stage_tick",
    address,
    payload: { stage, status, elapsed_ms, ...(error_hint ? { error_hint } : {}), ...(ide ? { ide } : {}) },
  });

  return c.json({ ok: true });
});

// POST /installer/complete
installerEventRoutes.post("/installer/complete", async (c) => {
  const address = await authOptional(c);
  const body = await parseJsonBody(c);
  if (body === null) return c.json({ ok: true }, 200);

  const success = !!body?.success;
  const fail_reason = body?.fail_reason != null ? String(body.fail_reason).slice(0, 100) : undefined;
  const total_elapsed_ms = Number.isFinite(Number(body?.total_elapsed_ms)) ? Number(body.total_elapsed_ms) : null;
  const idesRaw = Array.isArray(body?.ides_configured) ? body.ides_configured.slice(0, 10) : [];
  const ides_configured = idesRaw.map((x: unknown) => String(x).slice(0, 20));

  recordEvent({
    type: "installer_complete",
    address,
    payload: { success, ...(fail_reason ? { fail_reason } : {}), total_elapsed_ms, ides_configured },
  });

  return c.json({ ok: true });
});
