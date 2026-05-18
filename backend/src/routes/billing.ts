// Billing routes — non-custodial Solana SPL Approve / TransferChecked.
//
// BETA (rate=0): /allowance returns {rate=0, status:"BETA — free"}.
//                Push/react never charges, never reads on-chain allowance.
// Paid (rate=1): /allowance reads on-chain delegate; /approve-tx returns unsigned
//                Approve tx for the client to sign; first push after switch hits
//                402 + approve_again_url.
//
// /usage stays — it's transparency on what the user has been charged.

import { Hono } from "hono";
import type { Context } from "hono";
import { sql } from "../db.ts";
import { authedAddress, AuthError } from "../auth.ts";
import { config } from "../config.ts";
import {
  spenderPubkey, getAllowance, buildApproveTx, isLikelyPubkey,
} from "../lib/solana.ts";
import { parseJsonBody, invalidJson } from "../lib/http.ts";

export const billingRoutes = new Hono();

async function withAuth(c: Context) { return await authedAddress(c.req.header("authorization")); }
function authError(c: Context, e: unknown) {
  if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
  throw e;
}

/** Build the canonical allowance response. Used by GET /allowance and as the
 *  piggyback `allowance_after` in push/react 201 bodies. */
export async function buildAllowanceResponse(address: string): Promise<{
  address: string;
  rate_usd_per_call: number;
  status: "free_credits" | "paid" | "BETA — free";
  free_credits_usd: number;
  free_credits_calls_remaining: number;
  allowance_usd: number | null;
  estimated_calls_remaining: number | null;
  spender_pubkey: string | null;
  usdc_mint: string;
  cluster: string;
  approve_again_url: string;
}> {
  const rate = config.billingRateUsd;
  const cluster = config.solanaCluster;
  const usdcMint = config.usdcMint;
  const approveUrl = `https://susurration.xyz/approve?amount=100`;

  // Read free credits from DB. NUMERIC columns return as JS number via the
  // postgres.js parser registered in db.ts.
  const creditRows = await sql<{ free_credits_usd: number }[]>`
    SELECT free_credits_usd FROM identities WHERE address = ${address}
  `;
  const freeCredits = creditRows[0]?.free_credits_usd ?? 0;
  const freeCallsRemaining = rate > 0 ? Math.floor(freeCredits / rate) : 0;

  if (rate === 0) {
    return {
      address,
      rate_usd_per_call: 0,
      status: "BETA — free",
      free_credits_usd: freeCredits,
      free_credits_calls_remaining: freeCallsRemaining,
      allowance_usd: null,
      estimated_calls_remaining: null,
      spender_pubkey: null,
      usdc_mint: usdcMint,
      cluster,
      approve_again_url: approveUrl,
    };
  }

  // Determine status: using free credits or on-chain paid.
  const usingFreeCredits = freeCredits >= rate;

  // Read on-chain allowance (needed even while on credits, for transparency).
  let spender: string | null = null;
  let allowance = 0;
  try {
    spender = await spenderPubkey();
    allowance = await getAllowance(address);
  } catch (e) {
    console.warn("[billing] allowance read failed:", (e as Error).message);
  }

  return {
    address,
    rate_usd_per_call: rate,
    status: usingFreeCredits ? "free_credits" : "paid",
    free_credits_usd: freeCredits,
    free_credits_calls_remaining: freeCallsRemaining,
    allowance_usd: allowance,
    estimated_calls_remaining: rate > 0 ? Math.floor((freeCredits + allowance) / rate) : null,
    spender_pubkey: spender,
    usdc_mint: usdcMint,
    cluster,
    approve_again_url: approveUrl,
  };
}

// GET /api/billing/allowance — D6 transparency, on-chain truth
billingRoutes.get("/billing/allowance", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const out = await buildAllowanceResponse(me);
  return c.json(out);
});

// GET /api/billing/spender — current spender pubkey + USDC mint + cluster.
// Public (no auth). Lets clients verify the spender they're signing Approve to.
billingRoutes.get("/billing/spender", async (c) => {
  try {
    const pubkey = await spenderPubkey();
    return c.json({
      spender_pubkey: pubkey,
      usdc_mint: config.usdcMint,
      cluster: config.solanaCluster,
      rate_usd_per_call: config.billingRateUsd,
    });
  } catch (e) {
    return c.json({ error: "spender_unavailable" }, 503);
  }
});

// POST /api/billing/approve-tx — body {amount_usd?: number}
// Returns base64-encoded unsigned Approve tx. Client signs in Phantom + submits.
billingRoutes.post("/billing/approve-tx", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const amount = Number(body?.amount_usd ?? 100);
  if (!Number.isFinite(amount) || amount <= 0) {
    return c.json({ error: "amount_usd must be > 0" }, 400);
  }
  if (amount > 10_000) {
    return c.json({ error: "amount_usd too large (max $10,000)" }, 400);
  }
  try {
    const out = await buildApproveTx({ userAddress: me, amountUsd: amount });
    return c.json(out);
  } catch (e) {
    console.error("[billing] approve-tx build failed:", e);
    return c.json({ error: "approve_tx_build_failed" }, 500);
  }
});

// GET /api/usage — D6 transparency on charged calls. Unchanged from BETA-1.
billingRoutes.get("/usage", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }

  const since = c.req.query("since");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 1000);

  const rows = since
    ? await sql<any[]>`
        SELECT usage_id, channel_id, signal_id, reaction_id, call_type, cost_usd, created_at
        FROM usage_log
        WHERE address = ${me} AND created_at > ${since}
        ORDER BY created_at DESC LIMIT ${limit}
      `
    : await sql<any[]>`
        SELECT usage_id, channel_id, signal_id, reaction_id, call_type, cost_usd, created_at
        FROM usage_log
        WHERE address = ${me}
        ORDER BY created_at DESC LIMIT ${limit}
      `;

  const totals = await sql<{ count: number; cost: string | null }[]>`
    SELECT count(*)::int AS count, COALESCE(sum(cost_usd), 0)::text AS cost
    FROM usage_log WHERE address = ${me} ${since ? sql`AND created_at > ${since}` : sql``}
  `;
  const t = totals[0]!;

  return c.json({
    address: me,
    rate_usd_per_call: config.billingRateUsd,
    total_calls: t.count,
    total_cost_usd: Number(t.cost ?? 0),
    items: rows,
  });
});

void isLikelyPubkey; // re-export marker
