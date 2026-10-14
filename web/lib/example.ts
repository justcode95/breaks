// A made-up break to try the verifier with. Nothing here is real: the wallets and cards are derived from words.

import { base58 } from "@scure/base";
import { hashv, toHex, utf8 } from "./draw/bytes";
import type { VerifyInput } from "./verify";

const name = (word: string, i: number) => base58.encode(hashv(utf8(`example ${word} ${i}`)));

export function exampleInput(): VerifyInput {
  const holders = Array.from({ length: 6 }, (_, i) => `${name("holder", i)} ${[10, 30, 5, 50, 20, 15][i]}`).join("\n");
  return {
    seed: toHex(hashv(utf8("example seed"))),
    holders: `# wallet weight, one per line\n${holders}`,
    freeSpots: "2",
    paidOwners: Array.from({ length: 3 }, (_, i) => name("buyer", i)).join("\n"),
    cards: Array.from({ length: 5 }, (_, i) => name("card", i)).join("\n"),
    expected: { root: "", totalWeight: "", entryCount: "", poolHash: "" },
  };
}

export const emptyInput = (): VerifyInput => ({ seed: "", holders: "", freeSpots: "2", paidOwners: "", cards: "", expected: { root: "", totalWeight: "", entryCount: "", poolHash: "" } });
