// A made-up break to try the verifier with. Nothing here is real: the wallets and cards are derived from words.

import { base58 } from "@scure/base";
import { hashv, toHex, utf8 } from "./draw/bytes";
import type { VerifyInput } from "./verify";

const name = (word: string, i: number) => base58.encode(hashv(utf8(`example ${word} ${i}`)));

const WINDOW = { start: 1_800_000_000, end: 1_800_043_200 };
const HALF = (WINDOW.end - WINDOW.start) / 2;
const WEIGHTS = [10, 30, 5, 50, 20, 15];

/**
 * The balance events behind the example's weights, in the published format. Each weight is the wallet's time-weighted average
 * balance over the window: one held 10 all along, one bought 60 halfway (30), one sold its 10 halfway (5), one held 50 (50), one
 * held 12 and 8 in two token accounts (20), one held 10 and bought 10 more halfway (15). A wallet that is not on the list
 * (an exchange, say) held 1000 all along.
 */
function exampleInputs(): string {
  const before = WINDOW.start;
  const mid = WINDOW.start + HALF;
  const steps: { owner: string; account: string; time: number; delta: number }[] = [
    { owner: name("holder", 0), account: name("account", 0), time: before - 1000, delta: 10 },
    { owner: name("holder", 1), account: name("account", 1), time: mid, delta: 60 },
    { owner: name("holder", 2), account: name("account", 2), time: before - 1000, delta: 10 },
    { owner: name("holder", 2), account: name("account", 2), time: mid, delta: -10 },
    { owner: name("holder", 3), account: name("account", 3), time: before - 2000, delta: 50 },
    { owner: name("holder", 4), account: name("account", 4), time: before - 1000, delta: 12 },
    { owner: name("holder", 4), account: name("account", 40), time: before - 500, delta: 8 },
    { owner: name("holder", 5), account: name("account", 5), time: before - 1000, delta: 10 },
    { owner: name("holder", 5), account: name("account", 5), time: mid, delta: 10 },
    { owner: name("exchange", 0), account: name("account", 99), time: before - 3000, delta: 1000 },
  ];
  const held = new Map<string, number>();
  const lines = steps
    .sort((a, b) => a.time - b.time)
    .map((e, i) => {
      const after = (held.get(e.account) ?? 0) + e.delta;
      held.set(e.account, after);
      return `example-sig-${i + 1},${e.time},${e.time},${e.owner},${e.account},${e.delta},${after}`;
    });
  return `breaks:inputs:v1,${WINDOW.start},${WINDOW.end}\n${lines.join("\n")}\n`;
}

const noExpected = { root: "", totalWeight: "", entryCount: "", inputsHash: "", poolHash: "" };

export function exampleInput(): VerifyInput {
  const holders = WEIGHTS.map((w, i) => `${name("holder", i)} ${w}`).join("\n");
  return {
    seed: toHex(hashv(utf8("example seed"))),
    holders: `# wallet weight, one per line\n${holders}`,
    inputs: exampleInputs(),
    record: "",
    exclusions: "",
    freeSpots: "2",
    paidOwners: Array.from({ length: 3 }, (_, i) => name("buyer", i)).join("\n"),
    cards: Array.from({ length: 5 }, (_, i) => name("card", i)).join("\n"),
    expected: noExpected,
  };
}

export const emptyInput = (): VerifyInput => ({ seed: "", holders: "", inputs: "", record: "", exclusions: "", freeSpots: "2", paidOwners: "", cards: "", expected: noExpected });
