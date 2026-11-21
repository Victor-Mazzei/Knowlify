import { isIP } from "node:net";

export type IpKind = "public" | "loopback" | "private" | "link-local" | "reserved";

export type AllowPrivatePolicy =
  | { mode: "off" }
  | { mode: "on" }
  | { mode: "list"; cidrs: readonly string[] };

/** Parses a canonical dotted-quad address. Returns bytes so range checks stay readable. */
function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    bytes.push(byte);
  }
  return bytes;
}

/** Parses an IPv6 address, including a dotted IPv4 tail, into its 16 bytes. */
function parseIpv6(value: string): number[] | null {
  let text = value.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!text) return null;

  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const ipv4 = parseIpv4(tail);
    if (!ipv4) return null;
    const high = ((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0);
    const low = ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0);
    text = `${text.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  }

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const word = Number.parseInt(group, 16);
    bytes.push((word >> 8) & 0xff, word & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

function v4Bytes(bytes: readonly number[]): number[] {
  return bytes.slice(12, 16);
}

function isMappedV4(bytes: readonly number[]): boolean {
  for (let index = 0; index < 10; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

function classifyIpv4(bytes: readonly number[]): IpKind {
  const a = bytes[0] ?? 0;
  const b = bytes[1] ?? 0;
  const c = bytes[2] ?? 0;
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 10) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 0) return "reserved";
  if (a >= 224) return "reserved";
  if (a === 192 && b === 0 && c === 0) return "reserved";
  if (a === 192 && b === 0 && c === 2) return "reserved";
  if (a === 192 && b === 88 && c === 99) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "reserved";
  if (a === 203 && b === 0 && c === 113) return "reserved";
  return "public";
}

function classifyIpv6(bytes: readonly number[]): IpKind {
  if (isMappedV4(bytes)) return classifyIpv4(v4Bytes(bytes));
  const allZero = bytes.every((byte) => byte === 0);
  if (allZero) return "reserved";
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return "loopback";
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  if (first === 0xfe && (second & 0xc0) === 0x80) return "link-local";
  if ((first & 0xfe) === 0xfc) return "private";
  if (first === 0xff) return "reserved";
  if (first === 0x20 && second === 0x01) {
    const third = bytes[2] ?? 0;
    const fourth = bytes[3] ?? 0;
    if (third === 0x0d && fourth === 0xb8) return "reserved"; // documentation
    if (third === 0x00 && fourth === 0x00) return "reserved"; // Teredo
    if (third === 0x00 && fourth === 0x02) return "reserved"; // benchmarking
  }
  if (first === 0x20 && second === 0x02) return "reserved"; // 6to4
  if (first === 0x3f && second === 0xff) return "reserved"; // documentation
  if ((first & 0xe0) === 0x20) return "public";
  return "reserved";
}

/** Classifies a literal address; `null` when the input is not an IP address. */
export function classify(address: string): IpKind | null {
  const family = isIP(address);
  if (family === 4) {
    const bytes = parseIpv4(address);
    return bytes ? classifyIpv4(bytes) : null;
  }
  if (family === 6) {
    const bytes = parseIpv6(address);
    return bytes ? classifyIpv6(bytes) : null;
  }
  return null;
}

export function isValidCidr(cidr: string): boolean {
  return parseCidr(cidr) !== null;
}

interface ParsedCidr {
  bytes: number[];
  prefix: number;
}

function parseCidr(cidr: string): ParsedCidr | null {
  const parts = cidr.trim().split("/");
  if (parts.length > 2) return null;
  const base = parts[0] ?? "";
  const family = isIP(base);
  if (family === 0) return null;
  const bytes = family === 4 ? parseIpv4(base) : parseIpv6(base);
  if (!bytes) return null;
  const max = family === 4 ? 32 : 128;
  const prefix = parts.length === 2 ? Number(parts[1]) : max;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { bytes, prefix };
}

/** True when `address` is inside `cidr`; IPv4-mapped IPv6 is compared as IPv4. */
export function matchesCidr(address: string, cidr: string): boolean {
  const parsed = parseCidr(cidr);
  const family = isIP(address);
  if (!parsed || family === 0) return false;
  const bytes = family === 4 ? parseIpv4(address) : parseIpv6(address);
  if (!bytes) return false;
  const mapped = family === 6 ? isMappedV4(bytes) : false;
  const candidate = mapped ? v4Bytes(bytes) : bytes;
  const base = mapped && parsed.bytes.length === 16 ? null : parsed.bytes;
  if (!base || base.length !== candidate.length) return false;
  const fullBytes = Math.floor(parsed.prefix / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (candidate[index] !== base[index]) return false;
  }
  const remainder = parsed.prefix % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return ((candidate[fullBytes] ?? 0) & mask) === ((base[fullBytes] ?? 0) & mask);
}

export function isAddressAllowed(
  address: string,
  kind: IpKind,
  policy: AllowPrivatePolicy,
): boolean {
  switch (policy.mode) {
    case "off":
      return kind === "public";
    case "on":
      return kind === "public" || kind === "loopback" || kind === "private";
    case "list":
      return policy.cidrs.some((cidr) => matchesCidr(address, cidr));
  }
}

/** Parses `off` | `on` | comma-separated CIDRs. Invalid input falls back to the safe default. */
export function parseAllowPrivate(value: string | undefined): { policy: AllowPrivatePolicy; valid: boolean } {
  const raw = value?.trim().toLowerCase() ?? "";
  if (!raw || ["off", "0", "false", "no"].includes(raw)) return { policy: { mode: "off" }, valid: true };
  if (["on", "1", "true", "yes"].includes(raw)) return { policy: { mode: "on" }, valid: true };
  const cidrs = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (cidrs.length === 0 || cidrs.some((cidr) => !isValidCidr(cidr))) {
    return { policy: { mode: "off" }, valid: false };
  }
  return { policy: { mode: "list", cidrs }, valid: true };
}
