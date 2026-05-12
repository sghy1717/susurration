// Susurration backend config — environment-driven, no hidden defaults for secrets.

export const config = {
  port: Number(process.env.PORT ?? 8787),
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://susu:susu_dev@localhost:5432/susurration",

  // D5 atomic billing rule. Per-signal/reaction charge in USD.
  // Float so we can experiment with $0.50 etc without code changes.
  billingRateUsd: Number(process.env.BILLING_RATE_USD ?? 0.01),

  // Free credits: $5.00 per new identity (migration 007 DEFAULT).
  // Not runtime-configurable — change the migration DEFAULT to adjust.
  // Kept here as documentation only; meter() reads from DB, not config.

  // Solana cluster. devnet during dev, mainnet-beta in prod.
  solanaCluster: process.env.SOLANA_CLUSTER ?? "devnet",
  solanaRpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",

  // SPL USDC mint. Circle official:
  //   devnet:  4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
  //   mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  // Allow override for local mock USDC mint during testing.
  usdcMint:
    process.env.SUSU_USDC_MINT ??
    (process.env.SOLANA_CLUSTER === "mainnet-beta"
      ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      : "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),

  // Hot wallet keypair file. Dev: a local file we read at boot. Prod (later):
  // pull from macOS Keychain via shell-out. Generated on first start if absent.
  hotWalletKeypairPath:
    process.env.SUSU_HOT_WALLET_KEYPAIR ??
    `${process.env.HOME ?? "."}/.susu/dev-hot-wallet.json`,

  // R3 escape hatches for non-default Solana setups. Off by default.
  allowMintOverride: process.env.SUSU_ALLOW_MINT_OVERRIDE === "1",
  allowRpcHostnameMismatch: process.env.SUSU_ALLOW_RPC_HOSTNAME_MISMATCH === "1",

  // Per-deploy salt for hashing user addresses in `events` table.
  // Required for prod (privacy: same user → same hash → admin can join events
  // but cannot reverse to address). Rotate on operator demand.
  eventsHashSalt: process.env.SUSU_EVENTS_HASH_SALT ?? "dev-salt-do-not-use-in-prod",

  // Admin endpoints bearer token. Required for /api/admin/*.
  adminToken: process.env.SUSU_ADMIN_TOKEN ?? "",

  // @demo account keypair (base58-encoded 64-byte ed25519 secret key).
  // When set, the GS PRO scanner runs in-process and pushes signals as @demo.
  demoKeypairSecret: process.env.DEMO_KEYPAIR_SECRET ?? "",

  // Auth
  // Nonce TTL for sign-in challenge.
  authNonceTtlSec: 5 * 60,
  // Session token TTL after successful sig verification.
  sessionTtlSec: 30 * 24 * 3600,

  // CORS
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Channel constants from D1
  channelMinMembers: 2,
  channelMaxMembers: 20,

  // D8 governance constants
  proposalTtlHours: 24,
  // After a successful kick, owner cannot kick again for this many hours.
  kickCooldownHours: 24,
} as const;
