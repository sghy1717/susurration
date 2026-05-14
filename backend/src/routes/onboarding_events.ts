import { Hono } from "hono";
import { authedAddress, AuthError } from "../auth.ts";
import { parseJsonBody } from "../lib/http.ts";
import { check as rateCheck, RateLimitedError } from "../lib/rate_limit.ts";
import { recordEvent } from "../lib/events.ts";

export const onboardingEventRoutes = new Hono();

const REPORT_LIMIT = { windowMs: 60_000, max: 30 };
const ANON_REPORT_LIMIT = { windowMs: 60_000, max: 60 };

// POST /onboarding/event — fire-and-forget telemetry from web onboarding flow.
// Schema-less payload: { action, agent?, result?, context? }
// Used to answer "did the user have an agent / pick an IDE / try detect / skip?"
onboardingEventRoutes.post("/onboarding/event", async (c) => {
  let address: string | null = null;
  try {
    address = await authedAddress(c.req.header("authorization"));
    rateCheck(`onb-event:${address}`, REPORT_LIMIT);
  } catch (e) {
    if (e instanceof RateLimitedError) return c.json({ ok: true }, 200);
    if (e instanceof AuthError) {
      // pre-auth onboarding events (step 1 before signin) allowed but unattributed.
      // Rate limit by IP to prevent anonymous DoS / DB write amplification.
      const ip = c.req.header("fly-client-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
      try {
        rateCheck(`onb-event:ip:${ip}`, ANON_REPORT_LIMIT);
      } catch {
        return c.json({ ok: true }, 200);
      }
    } else {
      return c.json({ ok: true }, 200);
    }
  }

  const body = await parseJsonBody(c);
  if (body === null) return c.json({ ok: true }, 200);

  const action = String(body?.action ?? "unknown").slice(0, 50);
  const agent = body?.agent != null ? String(body.agent).slice(0, 20) : undefined;
  const result = body?.result != null ? String(body.result).slice(0, 20) : undefined;
  const context = body?.context && typeof body.context === "object"
    ? Object.fromEntries(Object.entries(body.context as Record<string, unknown>).slice(0, 10).map(
        ([k, v]) => [k.slice(0, 50), String(v).slice(0, 200)]
      ))
    : {};

  recordEvent({
    type: "onboarding_event",
    address,
    payload: { action, ...(agent ? { agent } : {}), ...(result ? { result } : {}), context },
  });

  return c.json({ ok: true });
});
