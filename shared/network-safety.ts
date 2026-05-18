// 2026-05-18 G review P1 #1 — extracted from
// `backend/src/routes/identity.ts` and `backend/src/lib/webhook.ts` which
// each held a verbatim copy. Single source of truth so updating
// private-IP coverage (e.g. cloud metadata 169.254.169.254 explicit deny,
// IPv6 ULA range tweaks) doesn't drift between setup-time validation and
// delivery-time re-resolution.

export const PRIVATE_HOST_PATTERN =
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.)/;

export function isPrivateOrLoopback(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost"
    || h.endsWith(".local")
    || h.endsWith(".internal")
    || h === "[::1]"
    || PRIVATE_HOST_PATTERN.test(h);
}

export function isPrivateIp(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;       // IPv6 ULA
  if (lower.startsWith("fe80:")) return true;                              // IPv6 link-local
  if (lower.startsWith("::ffff:")) return isPrivateIp(lower.slice(7));     // IPv4-mapped
  return PRIVATE_HOST_PATTERN.test(lower);
}
