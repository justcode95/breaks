import { describe, expect, it } from "vitest";
import { MockPackProvider } from "../src/pack-provider.js";

const opts = { machine: "pokemon-25", maxPrice: 25_000_000n };

describe("MockPackProvider", () => {
  it("never buys a second pack for the same (break, index)", async () => {
    const p = new MockPackProvider(25_000_000n);
    const key = { breakId: "1", index: 0 };
    const a = await p.buy(key, opts);
    const b = await p.buy(key, opts);
    expect(b).toEqual(a);
    expect(p.buyCalls).toBe(1);
  });

  it("gives distinct cards to distinct indexes", async () => {
    const p = new MockPackProvider(25_000_000n);
    const a = await p.buy({ breakId: "1", index: 0 }, opts);
    const b = await p.buy({ breakId: "1", index: 1 }, opts);
    expect(a.cardMint).not.toEqual(b.cardMint);
  });

  it("fails the purchase when the live price is above the cap, and does not retry it", async () => {
    const p = new MockPackProvider(26_000_000n);
    const key = { breakId: "1", index: 0 };
    expect((await p.buy(key, opts)).status).toBe("failed");
    p.setLivePrice(25_000_000n);
    expect((await p.buy(key, opts)).status).toBe("failed");
    expect(p.buyCalls).toBe(1);
  });

  it("returns undefined for an unknown key", async () => {
    expect(await new MockPackProvider(1n).get({ breakId: "9", index: 9 })).toBeUndefined();
  });
});
