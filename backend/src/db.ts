import postgres from "postgres";
import { config } from "./config.ts";

// Single shared connection pool. Bun keeps the process alive, so we keep
// the pool small and let postgres.js handle reconnect/idle.
export const sql = postgres(config.databaseUrl, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  types: {
    // Postgres NUMERIC (OID 1700) has no native JS counterpart; postgres.js's
    // default number parser only covers int2/int4/oid/float4/float8 (700/701),
    // so NUMERIC returns as string to preserve precision. That makes every
    // .toFixed() / arithmetic on a NUMERIC field a latent crash — the case
    // that caused /v2/daemon to white-screen (DaemonPage.tsx:169).
    //
    // We parse NUMERIC to JS number at the driver boundary. Precision argument:
    //   - cost_usd                 NUMERIC(12,8)  — per-call $0.0001 ballpark
    //   - balance/amount/allowance NUMERIC(20,8)  — capped at $10k by
    //                                                billing.ts:135 amount validator
    //   - free_credits_usd         NUMERIC(20,8)  — defaults to $5, top-ups
    //                                                bounded by amount_usd cap
    // IEEE 754 double = ~15-17 significant decimal digits. Max business value
    // ~$10000.12345678 = 13 sig figs — ~3 digits of headroom, no observable
    // precision loss (< 1e-10 USD).
    //
    // Side effect on writes: serialize is called when the driver knows the
    // target OID is 1700 (explicit cast / prepared statement). We pass through
    // as string via String(x), which is the correct text-format wire encoding
    // for NUMERIC regardless of input type.
    numeric: {
      to: 1700,
      from: [1700],
      serialize: (x: number | string) => String(x),
      parse: (x: string) => parseFloat(x),
    },
  },
});

// Querier accepts either the top-level Sql or a TransactionSql passed inside
// sql.begin(...). All helper functions in lib/* take this shape — they only
// need the tagged-template call signature and the .json() helper.
export type Querier = typeof sql | postgres.TransactionSql<{}>;
