// Phase 17.5 A — One-shot backfill of pre-Phase-11a paper trade history.
//
// Phase 18.2 update (2026-05-16): table renamed `paper_positions` → `positions`
// (migration 023). The SQL refs below have been updated. `mode` column defaults
// to 'paper' on insert; backfilled rows are pre-live-trading anyway. The
// script is still a one-shot — once run post-023, the WHERE clause finds no
// candidates and re-runs no-op. File name kept for git-history continuity.
//
// Problem: closes from daemons < 0.0.15 were written only to `position_closes`
// (signal_id + exit fields, no entry context). Users who upgraded to a newer
// daemon never see those historical closes in dashboard's `/paper_positions/mine`
// view, breaking the "complete trade record" product invariant.
//
// Solution: JOIN position_closes + signals.payload to reconstruct as much of
// the open-side context as the original trade_entry signal carried, INSERT
// into paper_positions with is_backfilled=true so dashboard tags them.
//
// Unrecoverable fields (per Phase 17.5 G review):
//   • position_usd  — never stored on signals.payload. Set to 0; is_backfilled
//                     flag tells dashboard not to count this as real $.
//   • size_factor   — set NULL (column allows).
//   • peer_username — set NULL.
//   • daemon_local_id — set NULL.
//   • leverage      — fallback to 3 when payload doesn't specify (warning logged).
//
// Usage:
//   bun run scripts/backfill_paper_positions.mjs --dry-run
//   bun run scripts/backfill_paper_positions.mjs --apply
//   bun run scripts/backfill_paper_positions.mjs --apply --username haze11111
//
// Run inside the fly machine (cat to bun --bun -) so DATABASE_URL is set:
//   cat scripts/backfill_paper_positions.mjs | \
//     fly ssh console -a susurration -C "bun run --bun -" -- --dry-run

import postgres from "postgres";

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--apply");
const FILTER_USERNAME = (() => {
  const i = args.indexOf("--username");
  return i >= 0 ? args[i + 1] : null;
})();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

function parsePayload(payload) {
  const p = payload ?? {};
  // Payload uses `metadata` (per signals.payload schema), not `meta`. Also
  // tolerate `meta` for any future schema drift.
  const meta = p.metadata ?? p.meta ?? {};
  const token = p.token ?? p.symbol ?? p.ticker ?? p.pair ?? meta.token;
  const direction = p.direction ?? p.side ?? p.dir ?? meta.direction;
  const entry = meta.entry_price ?? p.entry_price ?? p.entry ?? p.price;
  const leverageRaw = meta.leverage ?? p.leverage ?? p.lev;
  const stop_loss = meta.stop_loss ?? p.stop_loss ?? p.sl;
  const take_profit = meta.take_profit ?? p.take_profit ?? p.tp;
  return {
    token: typeof token === "string" ? token : null,
    direction: direction === "short" || direction === "long" ? direction : null,
    entry_price: typeof entry === "number" && isFinite(entry) ? entry : null,
    leverage: typeof leverageRaw === "number" && isFinite(leverageRaw) ? Math.round(leverageRaw) : null,
    leverage_fallback: !(typeof leverageRaw === "number" && isFinite(leverageRaw)),
    stop_loss: typeof stop_loss === "number" && isFinite(stop_loss) ? stop_loss : null,
    take_profit: typeof take_profit === "number" && isFinite(take_profit) ? take_profit : null,
  };
}

async function main() {
  console.log(`\nPhase 17.5 A — paper trade history backfill`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "APPLY"}`);
  if (FILTER_USERNAME) console.log(`Filter: username=${FILTER_USERNAME}`);
  console.log("");

  let userClause = sql``;
  if (FILTER_USERNAME) {
    const ids = await sql`SELECT address FROM identities WHERE username = ${FILTER_USERNAME}`;
    if (ids.length === 0) {
      console.error(`username ${FILTER_USERNAME} not found`);
      await sql.end();
      process.exit(1);
    }
    const addr = ids[0].address;
    userClause = sql`AND pc.address = ${addr}`;
  }

  // Candidate rows: position_closes entries with no matching paper_positions row.
  const candidates = await sql`
    SELECT
      pc.signal_id,
      pc.address,
      pc.exit_reason,
      pc.exit_price,
      pc.exit_pnl_pct,
      pc.closed_at,
      s.channel_id,
      s.payload,
      s.created_at AS signal_created_at
    FROM position_closes pc
    JOIN signals s ON s.signal_id::text = pc.signal_id
    LEFT JOIN positions pp
      ON pp.signal_id = s.signal_id AND pp.address = pc.address
    WHERE pp.position_id IS NULL
      ${userClause}
    ORDER BY pc.closed_at DESC
  `;

  console.log(`Candidates (position_closes rows w/o paper_positions row): ${candidates.length}`);

  let backfillable = 0;
  let skipUnparseable = 0;
  let leverageFallback = 0;
  const skipReasons = {};
  const toInsert = [];

  for (const row of candidates) {
    const parsed = parsePayload(row.payload);
    const missing = [];
    if (!parsed.token) missing.push("token");
    if (!parsed.direction) missing.push("direction");
    if (parsed.entry_price === null) missing.push("entry_price");
    if (parsed.stop_loss === null) missing.push("stop_loss");
    if (parsed.take_profit === null) missing.push("take_profit");

    if (missing.length > 0) {
      skipUnparseable++;
      const key = missing.sort().join("+");
      skipReasons[key] = (skipReasons[key] ?? 0) + 1;
      continue;
    }
    if (parsed.leverage_fallback) leverageFallback++;

    // Convert Date → ISO string defensively. postgres-js handles Date objects
    // in template literals natively for most types but timestamptz NOT NULL
    // DEFAULT now() columns have shown empirically to fall back to DEFAULT
    // when the bound parameter is a Date passed via tagged template. ISO
    // string is unambiguous.
    if (!row.signal_created_at) {
      // Defensive: should not happen given the JOIN, but if it did we'd
      // silently get DEFAULT now() — fatal for "historical" semantics.
      console.error(`[backfill] skipping ${row.signal_id}: missing signal_created_at`);
      skipUnparseable++;
      continue;
    }
    const openedAtIso = row.signal_created_at instanceof Date
      ? row.signal_created_at.toISOString()
      : String(row.signal_created_at);
    const closedAtIso = row.closed_at instanceof Date
      ? row.closed_at.toISOString()
      : String(row.closed_at);

    backfillable++;
    toInsert.push({
      address: row.address,
      signal_id: row.signal_id,
      channel_id: row.channel_id,
      token: parsed.token,
      direction: parsed.direction,
      leverage: parsed.leverage ?? 3, // fallback default
      entry_price: parsed.entry_price,
      stop_loss: parsed.stop_loss,
      take_profit: parsed.take_profit,
      position_usd: 0, // unrecoverable; is_backfilled flag tells UI
      size_factor: null,
      peer_username: null,
      is_replay: false,
      opened_at: openedAtIso,
      closed_at: closedAtIso,
      exit_reason: row.exit_reason,
      exit_price: row.exit_price,
      exit_pnl_pct: row.exit_pnl_pct,
      exit_pnl_usd: null, // can't compute without position_usd
      daemon_local_id: null,
      is_backfilled: true,
    });
  }

  console.log("");
  console.log(`Backfillable:           ${backfillable}`);
  console.log(`Skipped (missing payload fields): ${skipUnparseable}`);
  if (skipUnparseable > 0) {
    console.log(`  By missing-field combo:`);
    for (const [reason, count] of Object.entries(skipReasons).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${reason}: ${count}`);
    }
  }
  console.log(`Of backfillable, leverage=3 fallback: ${leverageFallback} / ${backfillable}`);

  if (DRY_RUN) {
    console.log("\n[DRY RUN] No writes performed. Re-run with --apply to insert.");
    console.log("Sample (first 3):");
    for (const r of toInsert.slice(0, 3)) {
      console.log(JSON.stringify({
        signal_id: r.signal_id.slice(0, 8) + "…",
        token: r.token, direction: r.direction, leverage: r.leverage,
        entry: r.entry_price, exit: r.exit_price, pnl_pct: r.exit_pnl_pct,
        is_backfilled: r.is_backfilled,
      }));
    }
    await sql.end();
    return;
  }

  // APPLY mode: insert in a single transaction. ON CONFLICT DO NOTHING in
  // case race / re-run.
  if (toInsert.length === 0) {
    console.log("\nNothing to insert.");
    await sql.end();
    return;
  }
  let inserted = 0;
  await sql.begin(async (tx) => {
    for (const r of toInsert) {
      const result = await tx`
        INSERT INTO positions (
          address, signal_id, channel_id, token, direction, leverage,
          entry_price, stop_loss, take_profit, position_usd, size_factor,
          peer_username, is_replay, opened_at, closed_at, exit_reason,
          exit_price, exit_pnl_pct, exit_pnl_usd, daemon_local_id, is_backfilled
        ) VALUES (
          ${r.address}, ${r.signal_id}::uuid, ${r.channel_id}, ${r.token}, ${r.direction}, ${r.leverage},
          ${r.entry_price}, ${r.stop_loss}, ${r.take_profit}, ${r.position_usd}, ${r.size_factor},
          ${r.peer_username}, ${r.is_replay}, ${r.opened_at}, ${r.closed_at}, ${r.exit_reason},
          ${r.exit_price}, ${r.exit_pnl_pct}, ${r.exit_pnl_usd}, ${r.daemon_local_id}, ${r.is_backfilled}
        )
        ON CONFLICT (address, signal_id) DO NOTHING
        RETURNING position_id
      `;
      if (result.length > 0) inserted++;
    }
  });
  console.log(`\n[APPLIED] Inserted ${inserted} / ${toInsert.length} rows (rest were ON CONFLICT no-ops).`);
  await sql.end();
}

main().catch(async (err) => {
  console.error("backfill failed:", err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
