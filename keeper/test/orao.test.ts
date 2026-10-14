import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OraoVrf } from "../src/pipeline/vrf.js";
import { ORAO_PROGRAM, oraoNetworkState, requestAddress } from "../src/solana/breaks.js";
import { decodeNetworkState } from "../src/solana/orao.js";
import { fromHex } from "../src/draw/bytes.js";
import { encodeNetworkState } from "./support/accounts.js";
import { addr } from "./support/chain.js";
import { MockChain } from "./support/mock-chain.js";
import { PROGRAMS } from "./support/world.js";

// test/fixtures/orao.json is written by tools/orao-fixtures with the REAL orao-solana-vrf 0.7.0 crate: the bytes of its
// network state, the PDA addresses, and the instruction its own SDK builds to request randomness.
interface Fixture {
  vrfProgram: string;
  networkStateAddress: string;
  requestAddress: string;
  payer: string;
  seed: string;
  tokenWallet: string;
  networkStates: { name: string; data: string; decoded: Record<string, unknown> }[];
  requests: { name: string; programId: string; data: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[] }[];
}
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "orao.json"), "utf8")) as Fixture;
const [solOnly, withToken] = fixture.networkStates as [Fixture["networkStates"][number], Fixture["networkStates"][number]];

/** The fields of the decoded state in the fixture's JSON form (numbers as text). */
const asJson = (s: ReturnType<typeof decodeNetworkState>) => ({
  authority: s.authority,
  treasury: s.treasury,
  requestFee: String(s.requestFee),
  fulfillmentAuthorities: s.fulfillmentAuthorities,
  tokenFee: s.tokenFee ? { mint: s.tokenFee.mint, treasury: s.tokenFee.treasury, fee: String(s.tokenFee.fee) } : null,
  numReceived: String(s.numReceived),
});

describe("ORAO's network state", () => {
  it("is the real ORAO program, with the PDA addresses the real crate computes", () => {
    expect(fixture.vrfProgram).toBe(ORAO_PROGRAM);
    expect(oraoNetworkState(ORAO_PROGRAM)).toBe(fixture.networkStateAddress);
    expect(requestAddress(ORAO_PROGRAM, fromHex(fixture.seed))).toBe(fixture.requestAddress);
  });

  it("is read exactly as the real crate wrote it, with and without a token fee", () => {
    for (const c of fixture.networkStates) expect(asJson(decodeNetworkState(fromHex(c.data))), c.name).toEqual(c.decoded);
  });

  it("reads it from the full account, which ORAO allocates with room to spare", () => {
    const real = fromHex(withToken.data);
    const padded = new Uint8Array(8 + 464);
    padded.set(real, 0);
    expect(asJson(decodeNetworkState(padded))).toEqual(withToken.decoded);
  });

  it("is written by the test encoder byte for byte like the real crate, so the tests' fixtures are real", () => {
    for (const c of fixture.networkStates) {
      const real = fromHex(c.data);
      const encoded = encodeNetworkState(decodeNetworkState(real));
      expect(encoded.subarray(0, real.length), c.name).toEqual(real);
      expect(encoded.subarray(real.length).every((b) => b === 0)).toBe(true);
      expect(encoded).toHaveLength(8 + 464);
    }
  });

  it("refuses what is not a network state", () => {
    const real = fromHex(solOnly.data);
    expect(() => decodeNetworkState(real.subarray(0, 60))).toThrow(/too short/);
    expect(() => decodeNetworkState(Uint8Array.from(real, (b, i) => (i === 0 ? b ^ 1 : b)))).toThrow(/not a NetworkState/);
    expect(() => decodeNetworkState(new Uint8Array())).toThrow(/not a NetworkState/);
    // A made-up list length cannot make it run on: the data runs out.
    const lying = Uint8Array.from(real);
    new DataView(lying.buffer).setUint32(8 + 32 + 32 + 8, 0xffffffff, true);
    expect(() => decodeNetworkState(lying)).toThrow(/too short/);
    // An option tag that is neither none nor some.
    const badTag = Uint8Array.from(real);
    badTag[8 + 32 + 32 + 8 + 4] = 2;
    expect(() => decodeNetworkState(badTag)).toThrow(/not a bool/);
  });
});

describe("OraoVrf", () => {
  const chainWith = (data?: Uint8Array) => {
    const chain = new MockChain(PROGRAMS, {
      admin: addr(2), keeper: addr(3), buyer: addr(4), usdcMint: addr(5), randomnessProgram: ORAO_PROGRAM, randomnessTimeoutSecs: 3_600n,
      nextBreakId: 0n, minWindowSecs: 21_600n, maxWindowSecs: 86_400n, maxPaidSpots: 20, maxFreeSpots: 6, paused: false, bump: 255,
    });
    if (data) chain.accounts.set(oraoNetworkState(ORAO_PROGRAM), data);
    return chain;
  };
  const sdkSol = fixture.requests.find((r) => r.name === "pay the fee in SOL")!;
  const sdkToken = fixture.requests.find((r) => r.name === "pay the fee in ORAO tokens")!;

  it("gives the accounts the real SDK puts in a SOL request: the network state and the SOL treasury", async () => {
    // With a token fee configured too, so choosing the wrong treasury would show.
    const vrf = new OraoVrf(chainWith(fromHex(withToken.data)), ORAO_PROGRAM);
    const accounts = await vrf.accounts();
    expect(accounts.networkState).toBe(sdkSol.accounts[1]!.pubkey);
    expect(accounts.treasury).toBe(sdkSol.accounts[2]!.pubkey);
    expect(accounts.extra).toBeUndefined();
    // The token treasury is a different account, which the keeper does not use.
    expect(sdkToken.accounts[2]!.pubkey).not.toBe(accounts.treasury);
    expect(sdkToken.accounts.length).toBe(sdkSol.accounts.length + 2);
  });

  it("reads the state, fee included", async () => {
    const state = await new OraoVrf(chainWith(fromHex(withToken.data)), ORAO_PROGRAM).state();
    expect(state.requestFee).toBe(15_000_000n);
    expect(state.fulfillmentAuthorities).toHaveLength(3);
    expect(state.tokenFee?.fee).toBe(7_000_000_000n);
  });

  it("follows a treasury that ORAO changes", async () => {
    const chain = chainWith(fromHex(solOnly.data));
    const vrf = new OraoVrf(chain, ORAO_PROGRAM);
    const before = await vrf.accounts();
    const changed = decodeNetworkState(fromHex(solOnly.data));
    chain.accounts.set(oraoNetworkState(ORAO_PROGRAM), encodeNetworkState({ ...changed, treasury: addr(0x99) }));
    expect(before.treasury).not.toBe(addr(0x99));
    expect((await vrf.accounts()).treasury).toBe(addr(0x99));
  });

  it("says what is wrong when there is no network state or it is not one", async () => {
    await expect(new OraoVrf(chainWith(), ORAO_PROGRAM).accounts()).rejects.toThrow(/does not exist on this cluster: is VRF_PROGRAM_ID/);
    await expect(new OraoVrf(chainWith(new Uint8Array(100)), ORAO_PROGRAM).accounts()).rejects.toThrow(/not a NetworkState/);
  });
});
