// Solana primitives — non-custodial billing via SPL Token Approve / TransferChecked.
//
// Spender wallet (server-side, was "hot wallet" pre-D13):
//   - Loaded from JSON keypair file (Solana CLI format = 64-byte ed25519 array)
//   - Generated on first boot if absent (dev convenience). Prod uses fly secrets.
//   - Acts as `delegate` authority for user SPL token Approve. NEVER receives
//     direct user transfers in non-custodial mode (post 2026-04-29 ADR).
//
// Charge flow (per push/react when BILLING_RATE_USD > 0):
//   1. User has previously signed Approve(spender, amount) on their USDC ATA
//   2. server signs TransferChecked(user_ata → revenue_ata, $1) with spender authority
//   3. SPL token program decrements delegated_amount; when it hits 0, user must
//      Approve again (lazy, triggered by 402 from /channels/:id/signals)
//
// Allowance read flow:
//   - getAllowance(user) reads user's USDC token account → delegate + delegatedAmount
//   - If delegate == our spender pubkey: allowance = delegatedAmount (in USD)
//   - Otherwise: 0 (user revoked or never approved)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createApproveInstruction,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  getAccount,
  AccountLayout,
} from "@solana/spl-token";
import { config } from "../config.ts";

let _connection: Connection | null = null;
let _hotKeypair: Keypair | null = null;

export function connection(): Connection {
  if (!_connection) {
    _connection = new Connection(config.solanaRpcUrl, "confirmed");
  }
  return _connection;
}

/** Load (or auto-generate in dev) the spender keypair. The spender is the
 *  delegate authority for SPL Token Approve — it can sign TransferChecked
 *  to debit user ATAs up to the approved amount. */
export async function spenderKeypair(): Promise<Keypair> {
  if (_hotKeypair) return _hotKeypair;
  const path = config.hotWalletKeypairPath;
  if (!existsSync(path)) {
    if (config.solanaCluster === "mainnet-beta") {
      throw new Error(
        `spender keypair not found at ${path} and cluster=mainnet-beta — refusing to auto-generate. ` +
          `Provision via fly secrets and set SUSU_HOT_WALLET_KEYPAIR.`,
      );
    }
    const kp = Keypair.generate();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    console.warn(`[susu] generated dev spender at ${path}: ${kp.publicKey.toBase58()}`);
    _hotKeypair = kp;
    return kp;
  }
  const raw = await readFile(path, "utf8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr) || arr.length !== 64) {
    throw new Error(`malformed keypair at ${path} (expected 64-byte secret key array)`);
  }
  _hotKeypair = Keypair.fromSecretKey(Uint8Array.from(arr));
  return _hotKeypair;
}

export async function spenderPubkey(): Promise<string> {
  return (await spenderKeypair()).publicKey.toBase58();
}

// Backward-compat aliases (some callers still import the old names).
export const hotWallet = spenderKeypair;
export const hotWalletPubkey = spenderPubkey;

export interface VerifiedDeposit {
  tx_signature: string;
  from_address: string;
  amount_usd: number;
  block_time: Date | null;
}

export class DepositError extends Error {
  constructor(public reason: string) { super(reason); }
}

// ─── NON-CUSTODIAL BILLING (D13 + non-custodial ADR) ───────────────────────────

const USDC_DECIMALS = 6;

/** Read on-chain SPL token allowance (delegated_amount) for user → our spender.
 *  Returns 0 if the user has no USDC ATA, no delegation, or delegated to someone else.
 *  Returns delegated USD amount otherwise. */
export async function getAllowance(userAddress: string): Promise<number> {
  const conn = connection();
  const userPk = new PublicKey(userAddress);
  const mintPk = new PublicKey(config.usdcMint);
  const spenderPk = (await spenderKeypair()).publicKey;
  const userAta = await getAssociatedTokenAddress(mintPk, userPk);

  try {
    const acc = await getAccount(conn, userAta);
    // delegate is null when user revoked or never approved.
    if (!acc.delegate) return 0;
    if (!acc.delegate.equals(spenderPk)) return 0;
    return Number(acc.delegatedAmount) / 10 ** USDC_DECIMALS;
  } catch (e) {
    // ATA doesn't exist yet (user has no USDC) — allowance = 0.
    return 0;
  }
}

export class InsufficientAllowanceError extends Error {
  constructor(public allowance_usd: number, public required_usd: number) {
    super("insufficient_allowance");
  }
}

/** Sign and send TransferChecked from user_ata → spender_ata using spender as
 *  delegate authority. Decrements user's delegatedAmount on-chain.
 *  Throws InsufficientAllowanceError if delegation is < amount. Synchronous —
 *  returns only after on-chain confirmation. ~400ms-2s latency. */
export async function chargeUser(args: {
  userAddress: string;
  amountUsd: number;
}): Promise<{ tx_signature: string }> {
  const { userAddress, amountUsd } = args;
  const conn = connection();
  const spender = await spenderKeypair();
  const mintPk = new PublicKey(config.usdcMint);
  const userPk = new PublicKey(userAddress);
  const userAta = await getAssociatedTokenAddress(mintPk, userPk);
  const spenderAta = await getAssociatedTokenAddress(mintPk, spender.publicKey);

  // Pre-flight allowance check (saves an RPC roundtrip if user revoked).
  const allowance = await getAllowance(userAddress);
  if (allowance < amountUsd) {
    throw new InsufficientAllowanceError(allowance, amountUsd);
  }

  const amountRaw = BigInt(Math.round(amountUsd * 10 ** USDC_DECIMALS));
  const tx = new Transaction();

  // If our own ATA doesn't exist yet (first charge ever), create it. We pay rent.
  const spenderAtaInfo = await conn.getAccountInfo(spenderAta);
  if (!spenderAtaInfo) {
    tx.add(createAssociatedTokenAccountInstruction(
      spender.publicKey,  // payer
      spenderAta,
      spender.publicKey,  // owner
      mintPk,
    ));
  }

  // TransferChecked from user_ata to spender_ata, signer = spender (delegate).
  tx.add(createTransferCheckedInstruction(
    userAta,            // source
    mintPk,
    spenderAta,         // destination
    spender.publicKey,  // authority (delegate)
    amountRaw,
    USDC_DECIMALS,
  ));

  tx.feePayer = spender.publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(spender);

  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return { tx_signature: sig };
}

/** Build an unsigned Approve transaction for the client to sign (in Phantom).
 *  Returns base64-encoded serialized tx. The user signs in their wallet and
 *  submits to RPC themselves; we don't broadcast it for them.
 *  If the user has no USDC ATA yet, we ALSO insert createAssociatedTokenAccount
 *  in the same tx (user pays rent ~$0.002). Single signature, single confirm. */
export async function buildApproveTx(args: {
  userAddress: string;
  amountUsd: number;
}): Promise<{ tx_base64: string; spender_pubkey: string; expected_amount_usd: number }> {
  const { userAddress, amountUsd } = args;
  const conn = connection();
  const userPk = new PublicKey(userAddress);
  const mintPk = new PublicKey(config.usdcMint);
  const spenderPk = (await spenderKeypair()).publicKey;
  const userAta = await getAssociatedTokenAddress(mintPk, userPk);

  const tx = new Transaction();

  // If user has no USDC ATA, create it in the same tx. Required for Approve.
  const ataInfo = await conn.getAccountInfo(userAta);
  if (!ataInfo) {
    tx.add(createAssociatedTokenAccountInstruction(
      userPk,        // payer = user
      userAta,
      userPk,        // owner
      mintPk,
    ));
  }

  const amountRaw = BigInt(Math.round(amountUsd * 10 ** USDC_DECIMALS));
  tx.add(createApproveInstruction(
    userAta,
    spenderPk,
    userPk,         // authority = user (signs)
    amountRaw,
    [],
    TOKEN_PROGRAM_ID,
  ));

  tx.feePayer = userPk;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  const tx_base64 = tx.serialize({ requireAllSignatures: false }).toString("base64");
  return { tx_base64, spender_pubkey: spenderPk.toBase58(), expected_amount_usd: amountUsd };
}

void AccountLayout; // re-export marker; not all imports used in this file

// ─── (Legacy custodial deposit verification — kept for now, deleted in
// the same batch by routes/billing.ts refactor) ─────────────────────────────

/** Pull a tx from RPC, verify it as a USDC transfer to the hot wallet, return amount.
 *  Throws DepositError on any verification failure with a user-safe reason.
 *  DEPRECATED — non-custodial mode doesn't accept deposits. Will be removed
 *  when routes/billing.ts no longer references it. */
export async function verifyUsdcDeposit(args: {
  txSignature: string;
  expectedFromAddress: string;
}): Promise<VerifiedDeposit> {
  const { txSignature, expectedFromAddress } = args;
  const conn = connection();
  const hot = (await hotWallet()).publicKey.toBase58();
  const usdc = config.usdcMint;

  const tx = await conn.getParsedTransaction(txSignature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx) throw new DepositError("tx not found or not yet confirmed");
  if (tx.meta?.err) throw new DepositError(`tx failed on-chain: ${JSON.stringify(tx.meta.err)}`);

  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  // Find the destination ATA owned by hot wallet for the USDC mint.
  const dest = post.find(
    (b) => b.mint === usdc && b.owner === hot,
  );
  if (!dest) {
    throw new DepositError(
      `no postTokenBalance with mint=${usdc} owner=${hot} — tx is not a USDC transfer to the hot wallet`,
    );
  }

  // Source must own a USDC ATA in the same tx with a matching debit.
  const source = pre.find(
    (b) => b.mint === usdc && b.owner === expectedFromAddress,
  );
  if (!source) {
    throw new DepositError(
      `no preTokenBalance with mint=${usdc} owner=${expectedFromAddress} — sender does not match authed wallet`,
    );
  }

  // Compute net credit on destination ATA (post - pre).
  const destPre = pre.find((b) => b.accountIndex === dest.accountIndex);
  const preAmt = BigInt(destPre?.uiTokenAmount.amount ?? "0");
  const postAmt = BigInt(dest.uiTokenAmount.amount);
  const deltaRaw = postAmt - preAmt;
  if (deltaRaw <= 0n) throw new DepositError("destination ATA delta is non-positive");

  // USDC has 6 decimals on-chain; convert to USD.
  const decimals = dest.uiTokenAmount.decimals ?? 6;
  const amountUsd = Number(deltaRaw) / 10 ** decimals;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new DepositError("amount overflow");
  }

  return {
    tx_signature: txSignature,
    from_address: expectedFromAddress,
    amount_usd: amountUsd,
    block_time: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
  };
}

// R3: refuse to start if SOLANA_CLUSTER, SOLANA_RPC_URL and SUSU_USDC_MINT
// don't agree. Mismatches let users send real USDC to the wrong mint or
// hot wallet → funds black-holed silently. This is a startup-time barrier
// so misconfig is caught immediately, not on first deposit.
const KNOWN_MINTS: Record<string, { mint: string; rpc_substring: string[] }> = {
  "mainnet-beta": {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    rpc_substring: ["mainnet"],
  },
  devnet: {
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    rpc_substring: ["devnet"],
  },
  // Add testnet/local as needed; refuse everything else.
};

export class ClusterMismatchError extends Error {
  constructor(reason: string) { super(`SOLANA cluster misconfig: ${reason}`); }
}

export function validateSolanaConfig(args: {
  cluster: string;
  rpcUrl: string;
  usdcMint: string;
  allowMintOverride?: boolean;
  allowOverride?: boolean;
  allowRpcHostnameMismatch?: boolean;
}): void {
  const known = KNOWN_MINTS[args.cluster];
  if (!known) {
    throw new ClusterMismatchError(
      `unknown cluster '${args.cluster}'. Known: ${Object.keys(KNOWN_MINTS).join(", ")}. ` +
      `Set SOLANA_CLUSTER explicitly.`,
    );
  }
  if (args.usdcMint !== known.mint) {
    if (!args.allowMintOverride && !args.allowOverride) {
      throw new ClusterMismatchError(
        `SUSU_USDC_MINT=${args.usdcMint} but cluster=${args.cluster} expects ${known.mint}. ` +
        `If this is intentional (local mock USDC), set SUSU_ALLOW_MINT_OVERRIDE=1.`,
      );
    }
  }
  const rpcLower = args.rpcUrl.toLowerCase();
  const rpcLooksRight = known.rpc_substring.some((s) => rpcLower.includes(s));
  const otherClusters = Object.keys(KNOWN_MINTS).filter((c) => c !== args.cluster);
  const rpcLooksWrong = otherClusters.some((other) =>
    KNOWN_MINTS[other]!.rpc_substring.some((s) => rpcLower.includes(s)),
  );
  if (rpcLooksWrong && !args.allowRpcHostnameMismatch) {
    throw new ClusterMismatchError(
      `SOLANA_RPC_URL=${args.rpcUrl} looks like a different cluster than SOLANA_CLUSTER=${args.cluster}. ` +
      `If this is intentional (private RPC endpoint), rename the host or set SUSU_ALLOW_RPC_HOSTNAME_MISMATCH=1.`,
    );
  }
  void rpcLooksRight;
}

export function isLikelyTxSignature(s: string): boolean {
  // Solana tx sigs are 64-byte signatures encoded base58 → ~87-88 chars.
  if (typeof s !== "string") return false;
  if (s.length < 64 || s.length > 100) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

export function isLikelyPubkey(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}
