// D5 atomic billing rule + free credits + non-custodial charge path.
//
// Charge priority:
//   1. Free credits (DB-side, fast, no on-chain call)
//   2. On-chain USDC via spender keypair (400ms-2s)
//   3. 402 Insufficient — neither credits nor allowance
//
// rate=0 (legacy BETA override): write usage_log row with cost=0, skip charge.
// rate>0: deduct from free_credits_usd first; if exhausted, chargeUser() on-chain.

import type { Querier } from "./db.ts";
import { config } from "./config.ts";
import { chargeUser, InsufficientAllowanceError } from "./lib/solana.ts";

export type CallType = "signal_push" | "reaction_push";

export interface MeterArgs {
  tx: Querier;
  address: string;
  channelId: string | null;
  signalId?: string | null;
  reactionId?: string | null;
  callType: CallType;
}

// Re-export so route handlers can import from a single place.
export { InsufficientAllowanceError };

/** Rate-aware atomic charge with free credits fallback.
 *
 *  1. If rate=0: write 0-cost usage_log, return (legacy BETA).
 *  2. If user has free_credits_usd >= cost: atomically deduct in DB, no on-chain.
 *  3. Else: chargeUser() on-chain (SPL TransferChecked).
 *     - InsufficientAllowanceError → route catches → 402.
 *     - RPC/network error → unhandled → route returns 500.
 *
 *  Free credits deduction is inside the caller's DB transaction (atomic).
 *  On-chain charge is external — same tradeoff as before: tx rollback after
 *  successful on-chain charge is rare and acceptable (truth is on-chain).
 */
export async function meter(args: MeterArgs): Promise<{ cost_usd: number; usage_id: string }> {
  const cost = config.billingRateUsd;

  if (cost > 0) {
    // Try free credits first (atomic DB deduct, no on-chain call).
    const credited = await args.tx<{ free_credits_usd: number }[]>`
      UPDATE identities
      SET free_credits_usd = free_credits_usd - ${cost}
      WHERE address = ${args.address}
        AND free_credits_usd >= ${cost}
      RETURNING free_credits_usd
    `;

    if (credited.length === 0) {
      // No free credits left — fall through to on-chain charge.
      // chargeUser may take 400ms-2s synchronously.
      await chargeUser({ userAddress: args.address, amountUsd: cost });
    }
  }

  const rows = await args.tx<{ usage_id: string }[]>`
    INSERT INTO usage_log(address, channel_id, signal_id, reaction_id, call_type, cost_usd)
    VALUES (
      ${args.address},
      ${args.channelId},
      ${args.signalId ?? null},
      ${args.reactionId ?? null},
      ${args.callType},
      ${cost}
    )
    RETURNING usage_id
  `;
  return { cost_usd: cost, usage_id: rows[0]!.usage_id };
}
