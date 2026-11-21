import { isIP } from "node:net";
import type { Server } from "bun";

/**
 * The address a request came from. `X-Client-IP` is honoured only when the TCP peer is one of
 * `trustedProxies`: Caddy sets it from the connection and Next passes it on. From anyone else the header
 * is client-controlled and ignored.
 */
export function clientIp(
  req: Request,
  server: Server<unknown>,
  trustedProxies: ReadonlySet<string>,
): string {
  const peer = normalizeIp(server.requestIP(req)?.address ?? "");
  if (trustedProxies.has(peer)) {
    const forwarded = normalizeIp(req.headers.get("x-client-ip")?.trim() ?? "");
    if (isIP(forwarded)) return forwarded;
  }
  return peer;
}

/** Lowercases, drops an IPv6 zone and unwraps IPv4-mapped IPv6 (`::ffff:1.2.3.4` → `1.2.3.4`). */
export function normalizeIp(address: string): string {
  const ip = address.toLowerCase().replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  return mapped?.[1] ?? ip;
}

/**
 * The rate-limit bucket for an address. One IPv6 host usually owns a whole /64, so a per-address limit
 * would be trivial to dodge; IPv6 addresses are keyed by their /64 prefix, IPv4 by the address.
 */
export function ipBucket(address: string): string {
  if (isIP(address) !== 6) return address;
  return `${expandIpv6(address).slice(0, 4).join(":")}::/64`;
}

function expandIpv6(address: string): string[] {
  const [head = "", tail] = address.split("::");
  const parse = (part: string) => (part ? part.split(":").flatMap(hextets) : []);
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const zeros = Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...zeros, ...right];
}

// An embedded IPv4 tail (e.g. ::1.2.3.4) is two hextets.
function hextets(group: string): string[] {
  if (!group.includes(".")) return [Number.parseInt(group, 16).toString(16)];
  const [a = 0, b = 0, c = 0, d = 0] = group.split(".").map(Number);
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}
