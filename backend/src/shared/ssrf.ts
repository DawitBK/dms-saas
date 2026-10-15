import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { lookup as dnsLookupAsync } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import net from "node:net";
import { AppError } from "../core/AppError.js";
import { config } from "../config/env.js";

/**
 * SSRF guard for user-supplied outbound URLs (currently webhook subscriptions).
 *
 * Layers:
 *  1. `assertSafeWebhookUrl` — synchronous, run at REGISTRATION time. Rejects
 *     non-http(s) schemes, embedded credentials, and hostnames that are literal
 *     private/loopback/link-local IPs (including bracketed and IPv4-mapped IPv6).
 *  2. `safeWebhookRequest` — the DELIVERY-time client. It resolves the hostname
 *     with a custom DNS `lookup` that validates EVERY resolved address and only
 *     lets the socket connect to public ones. Because undici/global-`fetch`
 *     re-resolves the hostname *independently* of any pre-flight check, a
 *     separate "resolve-then-fetch" is vulnerable to DNS rebinding (TOCTOU): the
 *     attacker returns a public IP to the checker and an internal IP to the
 *     socket. Validating inside the connect-time `lookup` — and disabling socket
 *     pooling so the `lookup` runs on every delivery — makes validate-and-connect
 *     atomic and closes that hole. Redirects are never followed (a 3xx is a
 *     delivery failure), so a public endpoint cannot bounce us to an internal one.
 *  3. `assertResolvesToPublicAddress` — async pre-flight kept for fast-fail and
 *     clear error messages; the authoritative gate is the connect-time lookup.
 *
 * In non-production we allow loopback so local integration tests can point a
 * webhook at 127.0.0.1 / ::1; production always blocks it.
 */

function loopbackAllowed(): boolean {
  return config.NODE_ENV !== "production";
}

function isExemptLoopback(ip: string): boolean {
  return loopbackAllowed() && (ip === "127.0.0.1" || ip === "::1");
}

function ipv4IsBlocked(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  // Malformed → treat as blocked (fail closed).
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
  return false;
}

/**
 * Extract an embedded IPv4 address from the well-known IPv6 mapping/translation
 * forms, in BOTH dotted (`::ffff:127.0.0.1`) and hex (`::ffff:7f00:1`) notation.
 * Only the specific prefixes that actually carry a v4 payload are unpacked, so a
 * legitimate global IPv6 address ending in two hex groups is never mis-parsed as
 * a private v4. Returns null when there is no embedded v4.
 */
function embeddedIpv4(v6: string): string | null {
  const lower = v6.toLowerCase();
  const dotted = lower.match(/:((?:\d{1,3}\.){3}\d{1,3})$/);
  const isMappingPrefix =
    lower.startsWith("::ffff:") || // IPv4-mapped
    lower.startsWith("64:ff9b:") || // NAT64 well-known prefix 64:ff9b::/96
    /^::(?:[0-9a-f]{1,4}:){0,4}/.test(lower); // IPv4-compatible (deprecated) ::a.b.c.d / ::x:y
  if (dotted && isMappingPrefix) return dotted[1];
  const hexTail = lower.match(/:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexTail && isMappingPrefix) {
    const hi = parseInt(hexTail[1], 16);
    const lo = parseInt(hexTail[2], 16);
    if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return null;
}

/**
 * True if `ip` (an IPv4 or IPv6 literal) is loopback, private, link-local,
 * unique-local, CGNAT, multicast/reserved, or an IPv4-mapped/translated form of
 * any of those. Exported for regression testing of the classifier itself.
 */
export function isBlockedIp(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) return ipv4IsBlocked(ip);
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true; // loopback
    if (lower === "::") return true; // unspecified
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    // fec0::/10 deprecated site-local. Not covered by the fe[89ab] test above
    // (that spans fe80-febf only), still routable on plenty of real networks,
    // and still an internal-only range — so it belongs on the blocklist.
    if (/^fe[cdef]/.test(lower)) return true; // fec0::/10 site-local (deprecated)
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique-local
    const v4 = embeddedIpv4(lower);
    if (v4) return ipv4IsBlocked(v4); // ::ffff: / ::/compat / NAT64 embedded v4
    return false;
  }
  // Not a valid IP literal (a DNS name, or malformed). Not "blocked" as a literal;
  // DNS names are resolved and each address checked at delivery time.
  return false;
}

/** Strip the surrounding brackets Node keeps on IPv6 URL hostnames. */
function stripBrackets(hostname: string): string {
  const h = hostname.toLowerCase();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

export function assertSafeWebhookUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppError(400, "ERR-WEBHOOK-URL-INVALID", "Webhook URL is not a valid URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AppError(400, "ERR-WEBHOOK-URL-SCHEME", "Webhook URL must use http or https");
  }
  if (config.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new AppError(400, "ERR-WEBHOOK-URL-SCHEME", "Webhook URL must use https in production");
  }
  if (parsed.username || parsed.password) {
    throw new AppError(400, "ERR-WEBHOOK-URL-CREDENTIALS", "Webhook URL must not embed credentials");
  }

  const host = stripBrackets(parsed.hostname);
  if (host === "localhost" || host === "localhost.localdomain") {
    if (!loopbackAllowed()) {
      throw new AppError(400, "ERR-WEBHOOK-URL-BLOCKED", "Webhook URL host is not permitted");
    }
  }
  // Literal-IP hosts (v4, v6, bracketed v6, IPv4-mapped) are validated immediately;
  // DNS names are validated at delivery time by the connect-time lookup.
  if (net.isIP(host) && isBlockedIp(host) && !isExemptLoopback(host)) {
    throw new AppError(400, "ERR-WEBHOOK-URL-BLOCKED", "Webhook URL host is not permitted");
  }

  return parsed;
}

export async function assertResolvesToPublicAddress(rawUrl: string): Promise<void> {
  const parsed = new URL(rawUrl);
  const host = stripBrackets(parsed.hostname);

  if (net.isIP(host)) {
    if (isBlockedIp(host) && !isExemptLoopback(host)) {
      throw new AppError(400, "ERR-WEBHOOK-URL-BLOCKED", "Webhook URL resolves to a non-public address");
    }
    return;
  }

  if ((host === "localhost" || host === "localhost.localdomain") && loopbackAllowed()) {
    return;
  }

  const results = await dnsLookupAsync(host, { all: true });
  for (const { address } of results) {
    if (isBlockedIp(address) && !isExemptLoopback(address)) {
      throw new AppError(400, "ERR-WEBHOOK-URL-BLOCKED", "Webhook URL resolves to a non-public address");
    }
  }
}

/**
 * DNS lookup that validates every resolved address against the SSRF blocklist at
 * connect time. Rejecting here aborts the socket connection, so the request can
 * never reach an internal address even if DNS rebinds between checks.
 */
function ssrfValidatingLookup(
  hostname: string,
  options: Parameters<typeof dnsLookup>[1],
  callback: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void
): void {
  // `options` may be an object, a bare family number, or undefined. Normalize,
  // and remember whether the caller asked for the ARRAY form (all:true) so we
  // return the shape it expects. We always resolve with all:true internally so
  // EVERY candidate address is validated, but if the caller wanted the single
  // -address form (the default when autoSelectFamily is off) we must call back
  // with (err, address:string, family:number), not an array — otherwise Node's
  // isIP() rejects the array and destroys the socket (fails closed, but breaks
  // all deliveries). (S19 re-audit F2.)
  const optsObj =
    typeof options === "object" && options !== null
      ? options
      : typeof options === "number"
        ? { family: options }
        : {};
  const wantAll = (optsObj as { all?: boolean }).all === true;
  dnsLookup(hostname, { ...optsObj, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list: LookupAddress[] = Array.isArray(addresses)
      ? addresses
      : [addresses as unknown as LookupAddress];
    for (const a of list) {
      if (isBlockedIp(a.address) && !isExemptLoopback(a.address)) {
        return callback(
          new AppError(
            400,
            "ERR-WEBHOOK-URL-BLOCKED",
            `Webhook host resolves to a non-public address (${a.address})`
          ) as unknown as NodeJS.ErrnoException
        );
      }
    }
    if (wantAll) {
      callback(null, list as unknown, undefined);
    } else {
      const first = list[0];
      callback(null, first.address, first.family);
    }
  });
}

export interface SafeRequestResult {
  status: number;
  ok: boolean;
}

/**
 * SSRF-safe outbound HTTP(S) request for webhook delivery. Pins the connection
 * to DNS results validated at connect time, never pools sockets (so the lookup
 * runs on every delivery), never follows redirects, and enforces a timeout.
 */
export async function safeWebhookRequest(
  rawUrl: string,
  opts: { method: string; headers: Record<string, string>; body: string; timeoutMs: number }
): Promise<SafeRequestResult> {
  // Defense-in-depth: validate scheme, embedded credentials, AND literal
  // private/loopback IPs synchronously BEFORE connecting. The connect-time
  // ssrfValidatingLookup only fires for hostNAMES that go through DNS — a
  // literal-IP host (http://127.0.0.1) connects directly and never invokes it,
  // so without this a literal internal IP would slip past the delivery guard.
  // Registration already blocks these, but delivery must not depend on that
  // (S19 re-audit runtime verification). In non-prod, loopback stays allowed
  // here too, matching assertSafeWebhookUrl.
  const parsed = assertSafeWebhookUrl(rawUrl);
  const mod = parsed.protocol === "https:" ? https : http;
  return await new Promise<SafeRequestResult>((resolve, reject) => {
    const req = mod.request(
      rawUrl,
      {
        method: opts.method,
        headers: opts.headers,
        lookup: ssrfValidatingLookup as unknown as typeof dnsLookup,
        agent: false, // no socket pooling → the validating lookup runs every delivery
        timeout: opts.timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume(); // drain and free the socket
        resolve({ status, ok: status >= 200 && status < 300 });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Webhook request timed out after ${opts.timeoutMs}ms`)));
    req.on("error", (err) => reject(err));
    req.end(opts.body);
  });
}
