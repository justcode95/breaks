import { describe, expect, it } from "vitest";
import { fromHex, u16le, u64le, utf8 } from "../src/draw/bytes.js";
import { addressFromBytes, addressToBytes, findProgramAddress, isOnCurve } from "../src/solana/pubkey.js";

const TREASURY = "Bvq3U9fz2MiHkLH8u4zyt6T1bimxnaEuHkZhezNDT5R9";
const BREAKS = "8tmJjCG3D4TF7oPiPWNoaCjZ4pN2U4H237BSGVw2B8KU";
const ORAO = "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y";

// Reference values computed with the real Solana code (`Pubkey::find_program_address`).
const PDAS: { name: string; program: string; seeds: string[]; address: string; bump: number }[] = [
  { name: "treasury config", program: TREASURY, seeds: ["636f6e666967"], address: "HFqEtztrDn86NRFDEeLxta9Mqc7bRL9CzFUbm4MPwJge", bump: 253 },
  { name: "treasury subsidy vault", program: TREASURY, seeds: ["737562736964795f7661756c74"], address: "BRAaBwpXL6wDrYqP4fmTNT5WbmBT3XEwaafsci8qykr1", bump: 255 },
  { name: "breaks config", program: BREAKS, seeds: ["636f6e666967"], address: "C5QrML6Sz5tWBRyN8vRTa8stxteVcmXZ4zpYjeXFAqVk", bump: 255 },
  { name: "breaks treasury authority", program: BREAKS, seeds: ["74726561737572795f617574686f72697479"], address: "AYqRiKdbi3pxetaw4dcN45ELog9xQv5G2uDCho9NYyiL", bump: 255 },
  { name: "break 7", program: BREAKS, seeds: ["627265616b", "0700000000000000"], address: "Dza9nEpeiLgNKBf19xMxr4rjH4RNFRrFvZj6BBFz4BZ7", bump: 255 },
  {
    name: "escrow of break 7",
    program: BREAKS,
    seeds: ["657363726f77", "c10bd567ecde4932f8f47442b5ccdd85b14a4190691d6b703e4fda43129288f6"],
    address: "9TZ4rSB6MFboRWkyHVXu6o7evuW44Y79rhR1Kbj3bGGK",
    bump: 254,
  },
  {
    name: "spot 3 of break 7",
    program: BREAKS,
    seeds: ["73706f74", "c10bd567ecde4932f8f47442b5ccdd85b14a4190691d6b703e4fda43129288f6", "0300"],
    address: "ECRvDdYdsH5VizJDi4oZBU6o3baa1qsh9zFzTJE8tAdZ",
    bump: 254,
  },
  {
    name: "orao request",
    program: ORAO,
    seeds: ["6f72616f2d7672662d72616e646f6d6e6573732d72657175657374", "09".repeat(32)],
    address: "39MefeKkkhpPA5mEYdCmx3NfuSyUU8h7mr1BCuTwD6T7",
    bump: 254,
  },
  { name: "orao network state", program: ORAO, seeds: ["6f72616f2d7672662d6e6574776f726b2d636f6e66696775726174696f6e"], address: "5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK", bump: 255 },
];

describe("findProgramAddress", () => {
  for (const p of PDAS) {
    it(`matches the real Solana derivation: ${p.name}`, () => {
      const r = findProgramAddress(p.seeds.map(fromHex), p.program);
      expect(r).toEqual({ address: p.address, bump: p.bump });
    });
  }

  it("builds the seeds the programs use", () => {
    const break7 = findProgramAddress([utf8("break"), u64le(7n)], BREAKS).address;
    const escrow = findProgramAddress([utf8("escrow"), addressToBytes(break7)], BREAKS);
    expect(escrow.address).toBe("9TZ4rSB6MFboRWkyHVXu6o7evuW44Y79rhR1Kbj3bGGK");
    const spot = findProgramAddress([utf8("spot"), addressToBytes(break7), u16le(3)], BREAKS);
    expect(spot.address).toBe("ECRvDdYdsH5VizJDi4oZBU6o3baa1qsh9zFzTJE8tAdZ");
  });

  it("rejects too many or too long seeds", () => {
    expect(() => findProgramAddress(Array(17).fill(new Uint8Array(1)), BREAKS)).toThrow();
    expect(() => findProgramAddress([new Uint8Array(33)], BREAKS)).toThrow();
  });
});

describe("isOnCurve", () => {
  it("is true for ordinary keys and false for program-derived addresses", () => {
    for (const key of [TREASURY, BREAKS, ORAO, "11111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]) {
      expect(isOnCurve(addressToBytes(key)), key).toBe(true);
    }
    for (const p of PDAS) expect(isOnCurve(addressToBytes(p.address)), p.name).toBe(false);
  });
});

describe("base58", () => {
  it("round-trips and insists on 32 bytes", () => {
    expect(addressFromBytes(addressToBytes(TREASURY))).toBe(TREASURY);
    expect(() => addressToBytes("1111")).toThrow();
    expect(() => addressFromBytes(new Uint8Array(31))).toThrow();
  });
});
