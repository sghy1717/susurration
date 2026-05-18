import { createHmac, randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import { sql } from "../db.ts";

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export function signPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// 2026-05-18 P1 #5 — mirror identity.ts setup-time DNS guard at DELIVERY
// time. Identity validation rejects private/loopback at webhook_url
// registration, but a hostname registered as evil.com → 1.2.3.4 may later
// re-resolve to 127.0.0.1 (DNS rebinding) when we actually POST the event.
// 2026-05-18 G review P1 #1 follow-up — DRY refactored to shared lib.
import { isPrivateOrLoopback, isPrivateIp } from "../../../shared/network-safety.ts";

// Resolve hostname at delivery time and reject if any returned IP is
// private / loopback / link-local. Fail-closed: any DNS error → skip the
// delivery (the receiver's webhook is misconfigured / DNS is flaking, no
// reason to send signed payloads into the dark).
async function isSafeWebhookUrl(url: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, reason: "invalid_url" }; }
  if (parsed.protocol !== "https:") return { ok: false, reason: "non_https" };
  if (isPrivateOrLoopback(parsed.hostname)) return { ok: false, reason: "private_hostname" };
  try {
    const records = (await Promise.race([
      dns.lookup(parsed.hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("dns_timeout")), 3000),
      ),
    ])) as Array<{ address: string }>;
    if (!records?.length) return { ok: false, reason: "no_records" };
    for (const r of records) {
      if (isPrivateIp(r.address)) return { ok: false, reason: "private_ip" };
    }
    return { ok: true };
  } catch (e: any) {
    const reason = e?.code === "ENOTFOUND" ? "enotfound"
                 : e?.message === "dns_timeout" ? "dns_timeout"
                 : "dns_error";
    return { ok: false, reason };
  }
}

export async function deliverWebhook(
  address: string,
  event: Record<string, unknown>,
): Promise<void> {
  const rows = await sql<{ webhook_url: string; webhook_secret: string }[]>`
    SELECT webhook_url, webhook_secret FROM identities
    WHERE address = ${address} AND webhook_url IS NOT NULL
  `;
  if (!rows.length) return;
  const { webhook_url, webhook_secret } = rows[0]!;

  const safety = await isSafeWebhookUrl(webhook_url);
  if (!safety.ok) {
    console.warn(`[webhook] delivery skipped for ${address} (${safety.reason}): ${webhook_url}`);
    return;
  }

  const body = JSON.stringify(event);
  const signature = signPayload(webhook_secret, body);

  fetch(webhook_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Susu-Signature": signature,
      "X-Susu-Event": String(event.kind ?? "unknown"),
    },
    body,
    signal: AbortSignal.timeout(10_000),
  }).catch((e: unknown) => {
      console.warn(`[webhook] delivery failed: ${(e as Error).message ?? e}`);
    });
}

export async function deliverToChannelMembers(
  channelId: string,
  senderAddress: string,
  event: Record<string, unknown>,
): Promise<void> {
  const members = await sql<{ address: string; webhook_url: string; webhook_secret: string }[]>`
    SELECT i.address, i.webhook_url, i.webhook_secret FROM channel_members cm
    JOIN identities i ON i.address = cm.address
    WHERE cm.channel_id = ${channelId}
      AND cm.address != ${senderAddress}
      AND i.webhook_url IS NOT NULL
  `;
  const body = JSON.stringify(event);
  // 2026-05-18 G review P1 #2 — DNS resolve (3s timeout) was sequential
  // per member. N members in a channel with webhooks would block the
  // signal-publish caller for up to N × 3s before any fetch fired. Run
  // safety checks in parallel; each safe webhook then fires its fetch
  // fire-and-forget as before.
  await Promise.all(
    members.map(async (m) => {
      const safety = await isSafeWebhookUrl(m.webhook_url);
      if (!safety.ok) {
        console.warn(`[webhook] delivery skipped for ${m.address} (${safety.reason}): ${m.webhook_url}`);
        return;
      }
      const signature = signPayload(m.webhook_secret, body);
      fetch(m.webhook_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Susu-Signature": signature,
          "X-Susu-Event": String(event.kind ?? "unknown"),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      }).catch((e: unknown) => {
        console.warn(`[webhook] delivery failed: ${(e as Error).message ?? e}`);
      });
    }),
  );
}
