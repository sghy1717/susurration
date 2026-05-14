import { Hono } from "hono";
import { authedAddress, AuthError } from "../auth.ts";
import { parseJsonBody } from "../lib/http.ts";
import { check as rateCheck, RateLimitedError } from "../lib/rate_limit.ts";
import { recordEvent } from "../lib/events.ts";

export const daemonEventRoutes = new Hono();

// daemon decisions fire once per SSE event. Default max_calls_per_minute=10
// so realistic max is ~20/min/daemon (LLM call + execute path). 60/min gives
// 3× headroom and prevents single bad daemon from flooding events table.
const DECISION_LIMIT = { windowMs: 60_000, max: 60 };

// POST /daemon/decision — fire-and-forget telemetry from daemon decision loop.
// Lets us distinguish "silent daemon" (running but all noop) vs "dead daemon" (not connected).
//
// Payload: {
//   kind: "react" | "noop" | "push" | "error",
//   signal_id?: string,         // when kind=react, the parent signal
//   event_kind?: string,         // triggering event type
//   error_type?: string,         // when kind=error (auth/llm/quota/timeout/network)
//   latency_ms?: number,         // event arrival -> decision committed
//   context?: object             // freeform extra (model/provider/peer)
// }
daemonEventRoutes.post("/daemon/decision", async (c) => {
  let address: string | null;
  try {
    address = await authedAddress(c.req.header("authorization"));
    rateCheck(`daemon-decision:${address}`, DECISION_LIMIT);
  } catch (e) {
    // Decision telemetry is strictly authed — no anonymous fire.
    // RateLimit / Auth fail returns ok:200 (fire-and-forget contract).
    if (e instanceof RateLimitedError) return c.json({ ok: true }, 200);
    if (e instanceof AuthError) return c.json({ ok: true }, 200);
    return c.json({ ok: true }, 200);
  }

  const body = await parseJsonBody(c);
  if (body === null) return c.json({ ok: true }, 200);

  const kind = String(body?.kind ?? "unknown").slice(0, 20);
  const signal_id = body?.signal_id != null ? String(body.signal_id).slice(0, 64) : undefined;
  const event_kind = body?.event_kind != null ? String(body.event_kind).slice(0, 40) : undefined;
  const error_type = body?.error_type != null ? String(body.error_type).slice(0, 40) : undefined;
  const latency_ms = typeof body?.latency_ms === "number" ? Math.floor(body.latency_ms) : undefined;
  const context = body?.context && typeof body.context === "object"
    ? Object.fromEntries(Object.entries(body.context as Record<string, unknown>).slice(0, 10).map(
        ([k, v]) => [k.slice(0, 50), String(v).slice(0, 200)]
      ))
    : {};

  recordEvent({
    type: "daemon_decision",
    address,
    payload: {
      kind,
      ...(signal_id ? { signal_id } : {}),
      ...(event_kind ? { event_kind } : {}),
      ...(error_type ? { error_type } : {}),
      ...(latency_ms != null ? { latency_ms } : {}),
      context,
    },
  });

  return c.json({ ok: true });
});
