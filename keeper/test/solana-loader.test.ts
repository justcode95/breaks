import { describe, expect, it } from "vitest";
import { decodeProgramAccount, decodeProgramData, PROGRAM_ACCOUNT_BYTES, PROGRAM_DATA_METADATA_BYTES } from "../src/solana/loader.js";
import { decodeMint } from "../src/solana/token.js";
import { addressToBytes } from "../src/solana/pubkey.js";
import { addr } from "./support/chain.js";
import { mintData, programAccount, programDataAccount } from "./support/doctor-world.js";

// The loader's layouts, written out byte by byte from its definition (bincode: a little-endian u32 tag, then the fields) and
// from the Rust test kit's `programdata_metadata` (testkit/src/lib.rs), which writes the metadata the program tests deploy with.

describe("the upgradeable loader's accounts", () => {
  it("reads the program-data address out of a program account", () => {
    const bytes = new Uint8Array(36);
    bytes[0] = 2;
    bytes.set(addressToBytes(addr(0x44)), 4);
    expect(decodeProgramAccount(bytes)).toEqual({ programData: addr(0x44) });
    expect(PROGRAM_ACCOUNT_BYTES).toBe(36);
    expect(decodeProgramAccount(programAccount(addr(0x55)))).toEqual({ programData: addr(0x55) });
  });

  it("refuses anything that is not a program account", () => {
    const wrongTag = new Uint8Array(36);
    wrongTag[0] = 3;
    expect(() => decodeProgramAccount(wrongTag)).toThrow("not an upgradeable-loader program account");
    expect(() => decodeProgramAccount(new Uint8Array(35))).toThrow("not an upgradeable-loader program account");
    expect(() => decodeProgramAccount(new Uint8Array(0))).toThrow("not an upgradeable-loader program account");
    // A tag that needs more than its low byte.
    const high = new Uint8Array(36);
    high[0] = 2;
    high[1] = 1;
    expect(() => decodeProgramAccount(high)).toThrow();
  });

  it("reads the slot and the upgrade authority of a program-data account", () => {
    const bytes = new Uint8Array(45 + 8);
    bytes[0] = 3;
    new DataView(bytes.buffer).setBigUint64(4, 123_456_789n, true);
    bytes[12] = 1;
    bytes.set(addressToBytes(addr(0x66)), 13);
    expect(decodeProgramData(bytes)).toEqual({ slot: 123_456_789n, upgradeAuthority: addr(0x66) });
    expect(PROGRAM_DATA_METADATA_BYTES).toBe(45);
    // Only the first 45 bytes matter: the code follows them.
    expect(decodeProgramData(bytes.subarray(0, 45))).toEqual({ slot: 123_456_789n, upgradeAuthority: addr(0x66) });
  });

  it("reads a program that nobody can upgrade any more", () => {
    const bytes = new Uint8Array(45);
    bytes[0] = 3;
    new DataView(bytes.buffer).setBigUint64(4, 9n, true);
    expect(decodeProgramData(bytes)).toEqual({ slot: 9n });
    expect(decodeProgramData(programDataAccount(undefined, 77n))).toEqual({ slot: 77n });
    expect(decodeProgramData(programDataAccount(addr(0x77), 5n))).toEqual({ slot: 5n, upgradeAuthority: addr(0x77) });
  });

  it("refuses anything that is not program data, and an option byte that is neither 0 nor 1", () => {
    const wrongTag = new Uint8Array(45);
    wrongTag[0] = 2;
    expect(() => decodeProgramData(wrongTag)).toThrow("not an upgradeable-loader program-data account");
    expect(() => decodeProgramData(new Uint8Array(44).fill(0))).toThrow("not an upgradeable-loader program-data account");
    const odd = new Uint8Array(45);
    odd[0] = 3;
    odd[12] = 2;
    expect(() => decodeProgramData(odd)).toThrow("neither present nor absent");
  });
});

describe("a token mint", () => {
  it("reads the supply, the decimals and whether it is initialized, at the offsets of the token program's layout", () => {
    const data = new Uint8Array(82);
    new DataView(data.buffer).setBigUint64(36, 1_000_000_000_000_000n, true);
    data[44] = 6;
    data[45] = 1;
    expect(decodeMint(data)).toEqual({ supply: 1_000_000_000_000_000n, decimals: 6, initialized: true });
    expect(decodeMint(mintData(5n, 9))).toEqual({ supply: 5n, decimals: 9, initialized: true });
    expect(decodeMint(new Uint8Array(82))).toEqual({ supply: 0n, decimals: 0, initialized: false });
    // Only 1 means initialized: the flag is a bool, and anything else is not an initialized mint.
    const odd = new Uint8Array(82);
    odd[45] = 2;
    expect(decodeMint(odd).initialized).toBe(false);
    // A Token-2022 mint is longer and starts the same way.
    const longer = new Uint8Array(200);
    longer[44] = 9;
    longer[45] = 1;
    expect(decodeMint(longer)).toEqual({ supply: 0n, decimals: 9, initialized: true });
  });

  it("does not mix up the fields", () => {
    const data = new Uint8Array(82);
    data.fill(0xff, 0, 36); // the mint authority: must not leak into the supply
    data.fill(0xff, 46); // the freeze authority: must not leak either
    expect(decodeMint(data)).toEqual({ supply: 0n, decimals: 0, initialized: false });
  });

  it("refuses data that is too short to be a mint", () => {
    expect(() => decodeMint(new Uint8Array(81))).toThrow("at least 82 bytes");
    expect(() => decodeMint(new Uint8Array(0))).toThrow(RangeError);
  });
});
