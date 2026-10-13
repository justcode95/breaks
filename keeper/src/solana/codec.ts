// Borsh, the part the programs use: little-endian integers, bool, fixed byte arrays, addresses, vectors.
// Integers wider than 32 bits are bigint so nothing is lost on the way.

import { U64_MAX, concat } from "../draw/bytes.js";
import { accountDiscriminator } from "./instruction.js";
import { type Address, addressFromBytes, addressToBytes } from "./pubkey.js";

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export class Writer {
  private readonly parts: Uint8Array[] = [];

  u8(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new RangeError(`not a u8: ${n}`);
    this.parts.push(Uint8Array.of(n));
    return this;
  }

  u16(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError(`not a u16: ${n}`);
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, n, true);
    this.parts.push(out);
    return this;
  }

  u32(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new RangeError(`not a u32: ${n}`);
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, n, true);
    this.parts.push(out);
    return this;
  }

  u64(n: bigint): this {
    if (n < 0n || n > U64_MAX) throw new RangeError(`not a u64: ${n}`);
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, n, true);
    this.parts.push(out);
    return this;
  }

  i64(n: bigint): this {
    if (n < I64_MIN || n > I64_MAX) throw new RangeError(`not an i64: ${n}`);
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigInt64(0, n, true);
    this.parts.push(out);
    return this;
  }

  bool(b: boolean): this {
    return this.u8(b ? 1 : 0);
  }

  /** A fixed-size array (`[u8; N]`): exactly `length` bytes, no length prefix. */
  fixed(bytes: Uint8Array, length: number): this {
    if (bytes.length !== length) throw new RangeError(`expected ${length} bytes, got ${bytes.length}`);
    this.parts.push(bytes);
    return this;
  }

  address(a: Address): this {
    this.parts.push(addressToBytes(a));
    return this;
  }

  /** `Vec<T>`: u32 length, then the items. */
  vec<T>(items: readonly T[], write: (w: Writer, item: T) => void): this {
    this.u32(items.length);
    for (const item of items) write(this, item);
    return this;
  }

  finish(): Uint8Array {
    return concat(...this.parts);
  }
}

export class Reader {
  private at = 0;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private take(n: number): number {
    if (this.at + n > this.data.length) throw new RangeError("account data is too short");
    const start = this.at;
    this.at += n;
    return start;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }

  u16(): number {
    return this.view.getUint16(this.take(2), true);
  }

  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }

  u64(): bigint {
    return this.view.getBigUint64(this.take(8), true);
  }

  i64(): bigint {
    return this.view.getBigInt64(this.take(8), true);
  }

  bool(): boolean {
    const b = this.u8();
    if (b > 1) throw new RangeError(`not a bool: ${b}`);
    return b === 1;
  }

  fixed(length: number): Uint8Array {
    const start = this.take(length);
    return this.data.slice(start, start + length);
  }

  address(): Address {
    return addressFromBytes(this.fixed(32));
  }

  /** Bytes left after what was read (accounts are allocated with their full size, so this is normally 0). */
  get remaining(): number {
    return this.data.length - this.at;
  }
}

/** A reader positioned after the 8-byte Anchor discriminator, which must be the one of `accountName`. */
export function accountReader(data: Uint8Array, accountName: string): Reader {
  const expected = accountDiscriminator(accountName);
  if (data.length < 8 || expected.some((b, i) => data[i] !== b)) {
    throw new Error(`not a ${accountName} account (wrong discriminator)`);
  }
  return new Reader(data.subarray(8));
}
