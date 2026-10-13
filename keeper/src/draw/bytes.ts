import { createHash } from "node:crypto";

export const U64_MAX = (1n << 64n) - 1n;

/** SHA-256 of the concatenation of `parts`. */
export function hashv(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

export function u64le(n: bigint): Uint8Array {
  if (n < 0n || n > U64_MAX) throw new RangeError(`not a u64: ${n}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}

export function u16le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError(`not a u16: ${n}`);
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, n, true);
  return out;
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) throw new Error(`bad hex: ${s}`);
  return new Uint8Array(Buffer.from(s, "hex"));
}

/** Lexicographic byte comparison (negative, zero or positive), like Rust's `[u8; N]` ordering. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && compareBytes(a, b) === 0;
}
