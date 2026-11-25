/** IPv4 helpers. All addresses are handled as unsigned 32-bit integers. */

export function ipToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n;
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function maskInt(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

export function maskStr(prefix: number): string {
  return intToIp(maskInt(prefix));
}

export interface Cidr {
  ip: number;
  prefix: number;
  /** network address */
  net: number;
}

/** Parses "a.b.c.d/nn". Prefix must be 1..30 (a usable host address must exist). */
export function parseCidr(s: string | undefined): Cidr | null {
  if (!s) return null;
  const [a, p, ...rest] = s.trim().split("/");
  if (rest.length || p === undefined || !/^\d{1,2}$/.test(p)) return null;
  const prefix = Number(p);
  const ip = ipToInt(a);
  if (ip === null || prefix < 1 || prefix > 30) return null;
  return { ip, prefix, net: (ip & maskInt(prefix)) >>> 0 };
}

/** Wildcard mask (inverse of the subnet mask), as used by access lists. */
export const wildcardStr = (prefix: number) => intToIp((~maskInt(prefix)) >>> 0);

export const netKey = (c: Cidr) => `${intToIp(c.net)}/${c.prefix}`;

export function inSameNet(a: Cidr, ip: number): boolean {
  return ((ip & maskInt(a.prefix)) >>> 0) === a.net;
}

export function netsOverlap(a: Cidr, b: Cidr): boolean {
  const p = Math.min(a.prefix, b.prefix);
  const m = maskInt(p);
  return ((a.net & m) >>> 0) === ((b.net & m) >>> 0);
}

/** First and last assignable host address of a network. */
export const firstHost = (c: Cidr) => c.net + 1;
export const lastHost = (c: Cidr) => (((c.net | (~maskInt(c.prefix) >>> 0)) >>> 0) - 1) >>> 0;
export const usableHosts = (c: Cidr) => Math.max(0, 2 ** (32 - c.prefix) - 2);

export const isNetworkAddr = (c: Cidr) => c.ip === c.net;

export function isBroadcastAddr(c: Cidr) {
  return c.ip === ((c.net | (~maskInt(c.prefix) >>> 0)) >>> 0);
}
