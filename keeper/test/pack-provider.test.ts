import { describe, expect, it } from "vitest";
import { MockPackProvider } from "../src/packs/mock-provider.js";
import { PriceAboveCapError } from "../src/packs/provider.js";

const opts = { machine: "pokemon-25", maxPrice: 25_000_000n };
const key = { breakId: "1", index: 0 };

describe("MockPackProvider", () => {
  it("preparing spends nothing and gives a signature and an expiry before anything is sent", async () => {
    const p = new MockPackProvider(25_000_000n);
    const prepared = await p.prepare(key, opts);
    expect(prepared.signature).toBeTruthy();
    expect(Number(prepared.expiry)).toBeGreaterThan(0);
    expect(p.moneySpent()).toBe(0n);
    expect(await p.findExisting(key)).toEqual([]);
    expect(await p.status(prepared.signature, prepared.expiry)).toEqual({ state: "pending" });
  });

  it("refuses to prepare above the cap", async () => {
    const p = new MockPackProvider(26_000_000n);
    await expect(p.prepare(key, opts)).rejects.toBeInstanceOf(PriceAboveCapError);
  });

  it("a submitted purchase lands, is found in history and reveals a card", async () => {
    const p = new MockPackProvider(25_000_000n);
    const prepared = await p.prepare(key, opts);
    await p.submit(prepared);
    expect(await p.status(prepared.signature, prepared.expiry)).toEqual({ state: "confirmed" });
    expect(await p.findExisting(key)).toEqual([{ signature: prepared.signature, expiry: prepared.expiry }]);
    expect(p.moneySpent()).toBe(25_000_000n);
    const reveal = await p.reveal(prepared.signature);
    expect(reveal?.cardMint).toMatch(/^mock-card-/);
    expect(reveal?.price).toBe(25_000_000n);
  });

  it("gives different cards to different indexes", async () => {
    const p = new MockPackProvider(1n);
    const a = await p.prepare({ breakId: "1", index: 0 }, opts);
    const b = await p.prepare({ breakId: "1", index: 1 }, opts);
    await p.submit(a);
    await p.submit(b);
    expect((await p.reveal(a.signature))?.cardMint).not.toEqual((await p.reveal(b.signature))?.cardMint);
  });

  it("a dropped purchase stays pending until its expiry, then is expired and never lands", async () => {
    const p = new MockPackProvider(1n);
    const prepared = await p.prepare(key, opts);
    p.queueSubmit("drop");
    await p.submit(prepared);
    expect(await p.status(prepared.signature, prepared.expiry)).toEqual({ state: "pending" });
    p.advanceBlocks(1_000);
    expect(await p.status(prepared.signature, prepared.expiry)).toEqual({ state: "expired" });
    // Sending the old transaction now does nothing: its blockhash is too old.
    await p.submit(prepared);
    expect(await p.status(prepared.signature, prepared.expiry)).toEqual({ state: "expired" });
    expect(p.moneySpent()).toBe(0n);
  });

  it("a reverted purchase costs nothing and reports why", async () => {
    const p = new MockPackProvider(5n);
    const prepared = await p.prepare(key, opts);
    p.queueSubmit("revert");
    await p.submit(prepared);
    expect((await p.status(prepared.signature, prepared.expiry)).state).toBe("failed");
    expect(p.moneySpent()).toBe(0n);
    expect(await p.reveal(prepared.signature)).toBeUndefined();
  });

  it("can land and still throw, like a timeout after the fact", async () => {
    const p = new MockPackProvider(5n);
    const prepared = await p.prepare(key, opts);
    p.queueSubmit("land-then-throw");
    await expect(p.submit(prepared)).rejects.toThrow();
    expect(await p.status(prepared.signature, prepared.expiry)).toEqual({ state: "confirmed" });
  });

  it("holds back the card for revealDelay calls", async () => {
    const p = new MockPackProvider(5n);
    p.revealDelay = 2;
    const prepared = await p.prepare(key, opts);
    await p.submit(prepared);
    expect(await p.reveal(prepared.signature)).toBeUndefined();
    expect(await p.reveal(prepared.signature)).toBeUndefined();
    expect(await p.reveal(prepared.signature)).toBeDefined();
  });
});
