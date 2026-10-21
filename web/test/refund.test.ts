import { readFileSync } from "node:fs";
import { join } from "node:path";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { type Address, SYSTEM_PROGRAM, TOKEN_PROGRAM, associatedTokenAddress, breakAddress, configAddress, escrowAddress, spotAddress } from "../lib/chain/address";
import { GENESIS_HASHES } from "../lib/chain/cluster";
import { LoadError } from "../lib/chain/load";
import { type RefundResult, checkRefund, loadRefundTerms, refundSpot, refundSpotInstruction } from "../lib/chain/refund";
import { openTokenAccountInstruction } from "../lib/chain/token-account";
import { BREAKS_ERRORS, SIGNATURE_FEE_LAMPORTS, describeTransactionError } from "../lib/chain/send";
import { buildTransaction } from "../lib/chain/transaction";
import { toHex } from "../lib/draw/bytes";
import {
  type BreakFields,
  type ConfigFields,
  type Served,
  breakFieldsFromVector,
  configFieldsFromVector,
  encodeBreak,
  encodeConfig,
  encodeSpot,
  encodeTokenAccount,
} from "./support/accounts";
import { decodeMessage, summary } from "./support/message";
import { type NodeScript, rpcNode } from "./support/node";
import { fill, pretendAccount, pretendWallet } from "./support/wallet";

type Case = { name: string; inputs: Record<string, any>; data?: string; accounts?: { pubkey: string; signer: boolean; writable: boolean }[]; outputs?: Record<string, any> | null };
const vectors: { programs: { breaks: string }; cases: Case[] } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"));
const named = (n: string) => vectors.cases.find((c) => c.name === n) as Case;
const PROGRAM = vectors.programs.breaks;
const CONFIG: ConfigFields = { ...configFieldsFromVector(named("breaks.account.BreaksConfig").outputs as Record<string, any>), paused: false };
const SAMPLE = breakFieldsFromVector(named("breaks.account.Break").outputs as Record<string, any>);
const NUMBER = Number(SAMPLE.id) + 1;
const INDEX = 3;
const BLOCKHASH = base58.encode(new Uint8Array(32).fill(9));
const ME = fill(5);
const ME_USDC = associatedTokenAddress(ME, CONFIG.usdcMint);
const SIG = base58.encode(new Uint8Array(64).fill(7));

describe("the refund_spot instruction", () => {
  it("is byte for byte the instruction the Rust program's own test builds", () => {
    const v = named("breaks.refund_spot");
    const ix = refundSpotInstruction({ program: PROGRAM, breakId: BigInt(v.inputs.breakId), index: v.inputs.index, ownerUsdc: v.inputs.ownerUsdc });
    expect(ix.programId).toBe(PROGRAM);
    expect(toHex(ix.data)).toBe(v.data);
    expect(ix.accounts.map((a) => ({ pubkey: a.pubkey, signer: a.signer, writable: a.writable }))).toEqual(v.accounts);
  });

  it("names this break's account, escrow and spot, pays the given USDC account, and nobody signs", () => {
    const ix = refundSpotInstruction({ program: PROGRAM, breakId: 12n, index: 5, ownerUsdc: ME_USDC });
    const breakKey = breakAddress(PROGRAM, 12n);
    expect(ix.accounts.map((a) => a.pubkey)).toEqual([breakKey, escrowAddress(PROGRAM, breakKey), spotAddress(PROGRAM, breakKey, 5), ME_USDC, TOKEN_PROGRAM]);
    // The sender only pays the fee: no account of the instruction signs, and the money can only go where the program says.
    expect(ix.accounts.some((a) => a.signer)).toBe(false);
    expect(ix.accounts.map((a) => a.writable)).toEqual([false, true, true, true, false]);
    expect(spotAddress(PROGRAM, breakKey, 6)).not.toBe(spotAddress(PROGRAM, breakKey, 5));
  });

  it("does not depend on which spot: the data is the same for every refund", () => {
    const a = refundSpotInstruction({ program: PROGRAM, breakId: 1n, index: 0, ownerUsdc: ME_USDC });
    const b = refundSpotInstruction({ program: PROGRAM, breakId: 9n, index: 40, ownerUsdc: ME_USDC });
    expect(toHex(a.data)).toBe(toHex(b.data));
  });
});

describe("what the program checks for a refund", () => {
  it("is that the break is cancelled and the spot is not refunded, in that order, and then what was paid", () => {
    expect(checkRefund({ break: { status: "Cancelled" }, spot: { paid: 20_000_000n, refunded: false } })).toEqual({ ok: true, amount: 20_000_000n });
    expect(checkRefund({ break: { status: "Cancelled" }, spot: { paid: 1n, refunded: true } })).toEqual({ ok: false, reason: "This spot was already refunded." });
    for (const status of ["Open", "Closed", "EligibilityCommitted", "Funded", "PoolCommitted", "RandomnessRequested", "Settled", "Drawn"] as const) {
      expect(checkRefund({ break: { status }, spot: { paid: 1n, refunded: false } }), status).toEqual({ ok: false, reason: "This break was not cancelled, so nothing is refunded." });
    }
    // Not cancelled comes first, as in the program.
    expect(checkRefund({ break: { status: "Drawn" }, spot: { paid: 1n, refunded: true } })).toMatchObject({ reason: "This break was not cancelled, so nothing is refunded." });
  });
});

function world(
  over: {
    brk?: Partial<BreakFields> | null;
    spot?: { owner?: Address; refunded?: boolean; paid?: bigint; breakId?: bigint; index?: number } | null;
    /** The wallet's USDC account: none, SOL sent to its address before it was opened, something else there, or a token account. */
    usdc?: "none" | "prefunded" | "system-data" | "frozen" | "other-mint" | bigint;
  } = {},
): Map<Address, Served> {
  const accounts = new Map<Address, Served>();
  accounts.set(configAddress(PROGRAM), { data: encodeConfig(CONFIG), owner: PROGRAM });
  if (over.brk !== null) accounts.set(breakAddress(PROGRAM, SAMPLE.id), { data: encodeBreak({ ...SAMPLE, status: "Cancelled", spotsSold: 5, freeWinnerCount: 0, freeWinners: [], ...over.brk }), owner: PROGRAM });
  if (over.spot !== null) {
    const s = over.spot ?? {};
    accounts.set(spotAddress(PROGRAM, breakAddress(PROGRAM, SAMPLE.id), INDEX), {
      data: encodeSpot({ breakId: s.breakId ?? SAMPLE.id, index: s.index ?? INDEX, owner: s.owner ?? ME, paid: s.paid ?? 20_000_000n, refunded: s.refunded ?? false }),
      owner: PROGRAM,
    });
  }
  if (over.usdc === "prefunded" || over.usdc === "system-data") {
    accounts.set(ME_USDC, { data: over.usdc === "prefunded" ? new Uint8Array(0) : new Uint8Array(8), owner: SYSTEM_PROGRAM });
  } else if (over.usdc !== "none") {
    const u = over.usdc;
    accounts.set(ME_USDC, {
      data: encodeTokenAccount({ mint: u === "other-mint" ? fill(8) : CONFIG.usdcMint, owner: ME, amount: typeof u === "bigint" ? u : 0n, ...(u === "frozen" ? { state: 2 as const } : {}) }),
      owner: TOKEN_PROGRAM,
    });
  }
  return accounts;
}

interface Setup {
  world?: Parameters<typeof world>[0];
  node?: Partial<NodeScript>;
  wallet?: Parameters<typeof pretendWallet>[0];
  index?: number;
  number?: number;
  timeoutMs?: number;
}

async function run(s: Setup = {}) {
  const node = rpcNode({ accounts: world(s.world), blockhash: BLOCKHASH, statuses: [{ err: null, confirmationStatus: "confirmed" }], ...s.node });
  const wallet = pretendWallet({ name: "Pretend", accounts: [pretendAccount(5)], ...s.wallet });
  const steps: string[] = [];
  let t = 0;
  const result: RefundResult = await refundSpot({
    rpcUrl: "http://node.test",
    program: PROGRAM,
    breakNumber: s.number ?? NUMBER,
    index: s.index ?? INDEX,
    wallet,
    account: pretendAccount(5),
    fetch: node.fetchFn,
    clock: () => t,
    sleep: async (ms) => void (t += ms),
    confirmTimeoutMs: s.timeoutMs ?? 10_000,
    pollMs: 1000,
    onStep: (step) => steps.push(step),
  });
  return { result, node, wallet, steps, elapsed: t };
}
const reason = async (s: Setup) => ((await run(s)).result as { kind: string; reason: string });

describe("refunding a spot", () => {
  it("checks everything, asks the wallet once to sign and send the right transaction, and waits for the network to confirm", async () => {
    const { result, node, wallet, steps } = await run();
    expect(result).toEqual({ kind: "refunded", signature: SIG, amount: 20_000_000n, opened: false });
    expect(steps).toEqual(["checking", "waiting-for-wallet", "confirming"]);

    expect(wallet.sendCalls).toHaveLength(1);
    const call = wallet.sendCalls[0];
    expect(call?.chain).toBe("solana:devnet");
    expect(call?.account.address).toBe(ME);
    const expected = buildTransaction({
      feePayer: ME,
      recentBlockhash: BLOCKHASH,
      instructions: [refundSpotInstruction({ program: PROGRAM, breakId: SAMPLE.id, index: INDEX, ownerUsdc: ME_USDC })],
    });
    // What the wallet was given is the refund for this spot, paying the wallet's own USDC account, with an empty signature slot.
    expect(call?.transaction).toEqual(expected.unsigned);
    expect(summary(decodeMessage((call?.transaction as Uint8Array).slice(65)))).toEqual(summary(decodeMessage(expected.message)));

    expect(node.methods()[0]).toBe("getGenesisHash");
    expect(node.methods()).not.toContain("sendTransaction");
    for (const c of node.calls.filter((c) => c.method === "getMultipleAccounts")) expect((c.params[1] as { commitment: string }).commitment).toBe("confirmed");
    expect(node.calls.find((c) => c.method === "getLatestBlockhash")?.params).toEqual([{ commitment: "confirmed" }]);
    expect(node.calls.find((c) => c.method === "getBalance")?.params).toEqual([ME, { commitment: "confirmed" }]);
  });

  it("is told the number of the break (the id is one less) and the spot, and reads exactly those accounts", async () => {
    const { node } = await run();
    const reads = node.calls.filter((c) => c.method === "getMultipleAccounts")[0];
    expect(reads?.params[0]).toEqual([breakAddress(PROGRAM, SAMPLE.id), spotAddress(PROGRAM, breakAddress(PROGRAM, SAMPLE.id), INDEX)]);
  });

  it("refuses, without asking the wallet, on any network that is not devnet", async () => {
    for (const genesis of [GENESIS_HASHES["mainnet-beta"], GENESIS_HASHES.testnet, "11111111111111111111111111111111"]) {
      const { result, wallet, node } = await run({ node: { genesis } });
      expect(result.kind).toBe("refused");
      expect((result as { reason: string }).reason).toContain("nothing was sent");
      expect(wallet.sendCalls).toHaveLength(0);
      expect(node.methods()).toEqual(["getGenesisHash"]);
    }
  });

  it("refuses, in words and without asking the wallet, when the node cannot be read", async () => {
    for (const method of ["getGenesisHash", "getMultipleAccounts", "getBalance", "getMinimumBalanceForRentExemption", "getLatestBlockhash"]) {
      const r = await run({ node: { failing: [method] } });
      expect(r.result.kind, method).toBe("refused");
      expect((r.result as { reason: string }).reason, method).toContain("nothing was sent");
      expect(r.wallet.sendCalls, method).toHaveLength(0);
    }
    const failed = await reason({ node: { failing: ["getBalance"], failMessage: "Try later." } });
    expect(failed.reason).toBe("Could not check the refund, so nothing was sent: the node refused the request: Try later.");
  });

  it("refuses a break or spot that is missing, not the program's, unreadable or another one", async () => {
    expect((await reason({ world: { brk: null } })).reason).toBe(`Break #${NUMBER} does not exist, so nothing was sent.`);
    expect((await reason({ world: { spot: null } })).reason).toBe(`Spot #${INDEX + 1} of break #${NUMBER} does not exist, so nothing was sent.`);
    const foreignBreak = world();
    foreignBreak.set(breakAddress(PROGRAM, SAMPLE.id), { ...(foreignBreak.get(breakAddress(PROGRAM, SAMPLE.id)) as Served), owner: fill(9) });
    expect((await reason({ node: { accounts: foreignBreak } })).reason).toBe("The break or the spot is not owned by the breaks program, so nothing was sent.");
    const spotKey = spotAddress(PROGRAM, breakAddress(PROGRAM, SAMPLE.id), INDEX);
    const foreignSpot = world();
    foreignSpot.set(spotKey, { ...(foreignSpot.get(spotKey) as Served), owner: fill(9) });
    expect((await reason({ node: { accounts: foreignSpot } })).reason).toBe("The break or the spot is not owned by the breaks program, so nothing was sent.");
    const garbled = world();
    garbled.set(spotKey, { data: new Uint8Array(20), owner: PROGRAM });
    expect((await reason({ node: { accounts: garbled } })).reason).toContain("could not be read");
    expect((await reason({ world: { brk: { id: 5n } } })).reason).toBe("The accounts found say they are another break or spot, so nothing was sent.");
    expect((await reason({ world: { spot: { breakId: 5n } } })).reason).toBe("The accounts found say they are another break or spot, so nothing was sent.");
    expect((await reason({ world: { spot: { index: 4 } } })).reason).toBe("The accounts found say they are another break or spot, so nothing was sent.");
  });

  it("refuses a spot of another wallet: this site refunds the connected wallet's own spots", async () => {
    const r = await reason({ world: { spot: { owner: fill(6) } } });
    expect(r.kind).toBe("refused");
    expect(r.reason).toBe("This spot belongs to another wallet. This site only sends refunds for the connected wallet's own spots, so nothing was sent.");
  });

  it("refuses a break that was not cancelled and a spot that was already refunded, with the program's words, before anything else is read", async () => {
    expect((await reason({ world: { brk: { status: "Drawn" } } })).reason).toBe("This break was not cancelled, so nothing is refunded.");
    expect((await reason({ world: { spot: { refunded: true } } })).reason).toBe("This spot was already refunded.");
    const r = await run({ world: { spot: { refunded: true } } });
    expect(r.node.methods()).not.toContain("getBalance");
    expect(r.wallet.sendCalls).toHaveLength(0);
  });

  it("opens the wallet's USDC account first, in the same transaction, when it has none, and says so", async () => {
    for (const usdc of ["none", "prefunded"] as const) {
      const { result, wallet, node } = await run({ world: { usdc } });
      expect(result, usdc).toEqual({ kind: "refunded", signature: SIG, amount: 20_000_000n, opened: true });
      expect(wallet.sendCalls).toHaveLength(1);
      const expected = buildTransaction({
        feePayer: ME,
        recentBlockhash: BLOCKHASH,
        instructions: [
          openTokenAccountInstruction({ payer: ME, owner: ME, mint: CONFIG.usdcMint }),
          refundSpotInstruction({ program: PROGRAM, breakId: SAMPLE.id, index: INDEX, ownerUsdc: ME_USDC }),
        ],
      });
      // The account opened is the one the refund pays: the wallet's own, for the program's USDC, paid for by the wallet.
      expect(wallet.sendCalls[0]?.transaction, usdc).toEqual(expected.unsigned);
      expect(node.calls.filter((c) => c.method === "getMinimumBalanceForRentExemption").map((c) => c.params[0]).sort()).toEqual([0, 165]);
    }
    // A wallet that has one, holding nothing or something, is paid into it and nothing is opened.
    for (const usdc of [0n, 5n]) {
      const { result, wallet } = await run({ world: { usdc } });
      expect(result).toMatchObject({ kind: "refunded", opened: false });
      expect(decodeMessage((wallet.sendCalls[0]?.transaction as Uint8Array).slice(65)).instructions).toHaveLength(1);
    }
  });

  it("refuses a wallet whose USDC address holds something that is not its USDC account", async () => {
    expect((await reason({ world: { usdc: "frozen" } })).reason).toContain("frozen");
    expect((await reason({ world: { usdc: "other-mint" } })).reason).toContain("holds another token");
    // An account of the system program with data in it cannot be opened as a token account.
    const r = await run({ world: { usdc: "system-data" } });
    expect(r.result).toMatchObject({ kind: "refused" });
    expect((r.result as { reason: string }).reason).toContain("not a token account");
    expect(r.wallet.sendCalls).toHaveLength(0);
  });

  it("refuses a wallet that cannot pay the fee, the rent of the account it opens and keep a valid account, down to the lamport", async () => {
    const need = Number(SIGNATURE_FEE_LAMPORTS) + 890_880 + 2_039_280;
    const short = await run({ world: { usdc: "none" }, node: { lamports: need - 1 } });
    expect(short.result).toMatchObject({ kind: "refused", reason: "This wallet needs about 0.00293516 SOL for the network fee and the rent of the USDC account this refund opens, and has 0.002935159 SOL." });
    expect(short.wallet.sendCalls).toHaveLength(0);
    expect((await run({ world: { usdc: "none" }, node: { lamports: need } })).result).toMatchObject({ kind: "refunded", opened: true });
    // The rent of the account comes from the node.
    expect((await run({ world: { usdc: "none" }, node: { lamports: need, rent: { tokenAccount: 2_039_281 } } })).result.kind).toBe("refused");
    // With an account already there, it is not part of what the wallet needs.
    expect((await run({ node: { lamports: need - 2_039_280 } })).result.kind).toBe("refunded");
  });

  it("says before the button is pressed whether a refund opens the USDC account, and what its rent is", async () => {
    const terms = (usdc: NonNullable<Parameters<typeof world>[0]>["usdc"], script: Partial<NodeScript> = {}) => {
      const node = rpcNode({ accounts: world({ usdc }), ...script });
      return { node, got: loadRefundTerms({ rpcUrl: "http://node.test", program: PROGRAM, owner: ME, fetch: node.fetchFn }) };
    };
    const has = terms(5n);
    expect(await has.got).toEqual({ opens: false });
    // Nothing more is asked when nothing is opened, and the account is read as the refund reads it.
    expect(has.node.methods()).toEqual(["getMultipleAccounts", "getMultipleAccounts"]);
    for (const c of has.node.calls) expect((c.params[1] as { commitment: string }).commitment).toBe("confirmed");
    expect(await terms("none").got).toEqual({ opens: true, rent: 2_039_280n });
    expect(await terms("prefunded", { rent: { tokenAccount: 3_000_000 } }).got).toEqual({ opens: true, rent: 3_000_000n });
    await expect(terms("frozen").got).rejects.toBeInstanceOf(LoadError);
    await expect(terms("none", { failing: ["getMinimumBalanceForRentExemption"] }).got).rejects.toThrow("is failing");
    await expect(terms(5n, { failing: ["getMultipleAccounts"] }).got).rejects.toThrow("is failing");
  });

  it("refuses a wallet that cannot pay the network fee and keep a valid account, down to the lamport", async () => {
    const need = Number(SIGNATURE_FEE_LAMPORTS) + 890_880;
    const short = await run({ node: { lamports: need - 1 } });
    expect(short.result).toMatchObject({ kind: "refused", reason: "This wallet needs about 0.00089588 SOL for the network fee, and has 0.000895879 SOL." });
    expect(short.wallet.sendCalls).toHaveLength(0);
    expect((await run({ node: { lamports: need } })).result.kind).toBe("refunded");
    // The rent comes from the node, and no account is created, so the rent of a spot account is not part of it.
    const dearer = await run({ node: { lamports: need, rent: { spot: 1, bare: 890_881 } } });
    expect(dearer.result.kind).toBe("refused");
    expect((await run({ node: { lamports: need, rent: { spot: 9_000_000, bare: 890_880 } } })).result.kind).toBe("refunded");
    const rentCalls = (await run()).node.calls.filter((c) => c.method === "getMinimumBalanceForRentExemption").map((c) => c.params[0]);
    expect(rentCalls).toEqual([0]);
  });

  it("refuses numbers that are not a break or a spot", async () => {
    for (const number of [0, -1, 1.5, Number.NaN]) expect((await reason({ number })).reason, String(number)).toBe("That is not a break number.");
    for (const index of [-1, 65536, 1.5, Number.NaN]) expect((await reason({ index })).reason, String(index)).toBe("That is not a spot.");
    // The first and the last spot a break can have are spots (this one is just not there).
    expect((await reason({ index: 0xffff })).reason).toBe(`Spot #65536 of break #${NUMBER} does not exist, so nothing was sent.`);
    expect((await reason({ index: 0 })).reason).toBe(`Spot #1 of break #${NUMBER} does not exist, so nothing was sent.`);
  });

  it("says the wallet declined, with a warning to look at its history first, when the wallet fails or gives nothing back", async () => {
    const declined = async (wallet: Setup["wallet"]) => (await run({ wallet })).result as { kind: string; reason: string };
    const rejected = await declined({ send: async () => Promise.reject(new Error("User rejected the request.")) });
    expect(rejected).toEqual({ kind: "declined", reason: "Pretend did not send the transaction: User rejected the request. If you approved it, check your wallet's history before trying again." });
    expect((await declined({ send: async () => [] })).reason).toContain("did not give back a transaction signature");
    expect(await declined({ only: ["connect"] })).toEqual({ kind: "declined", reason: "Pretend cannot send Solana transactions." });
  });

  it("says in words why the network refused a refund that landed, and that nothing was refunded", async () => {
    const failed = async (err: unknown) => (await run({ node: { statuses: [{ err, confirmationStatus: "confirmed" }] } })).result as { kind: string; reason: string; signature: string };
    const code = (name: (typeof BREAKS_ERRORS)[number]) => ({ InstructionError: [0, { Custom: 6000 + BREAKS_ERRORS.indexOf(name) }] });
    expect(await failed(code("AlreadyRefunded"))).toEqual({ kind: "failed", signature: SIG, reason: "This spot was already refunded." });
    expect((await failed(code("WrongStatus"))).reason).toBe("This break was not cancelled, so its spots are not refunded.");
    expect((await failed("BlockhashNotFound")).reason).toBe("The transaction was too old (its blockhash expired). Nothing was refunded; try again.");
    expect((await failed("InsufficientFundsForFee")).reason).toBe("The wallet does not have enough SOL for the network fee (and the rent of the USDC account, when the refund opens one).");
    // The buy flow's guesses about the token program do not apply: a refund names the number.
    for (const custom of [0, 1]) {
      expect((await failed({ InstructionError: [0, { Custom: custom }] })).reason).toBe(`The network refused it (${JSON.stringify({ InstructionError: [0, { Custom: custom }] })}).`);
    }
    expect((await failed({ InstructionError: [0, "InsufficientFunds"] })).reason).toBe(`The network refused it (${JSON.stringify({ InstructionError: [0, "InsufficientFunds"] })}).`);
  });

  it("says nothing was refunded when the transaction expired, and gives up with 'may still land' when the network does not answer", async () => {
    const expired = await run({ node: { statuses: [null], lastValidBlockHeight: 1000, heights: [1001] }, timeoutMs: 60_000 });
    expect(expired.result).toEqual({ kind: "failed", signature: SIG, reason: "The transaction expired before it landed, so nothing was refunded. You can try again." });
    const silent = await run({ node: { statuses: [null] }, timeoutMs: 5000 });
    expect(silent.result).toMatchObject({ kind: "unconfirmed", signature: SIG });
    expect((silent.result as { reason: string }).reason).toContain("It may still land");
    expect(silent.elapsed).toBe(5000);
  });

  it("accepts confirmed and finalized and not processed", async () => {
    const waited = await run({ node: { statuses: [null, { err: null, confirmationStatus: "processed" }, { err: null, confirmationStatus: "confirmed" }] } });
    expect(waited.result.kind).toBe("refunded");
    expect(waited.node.methods().filter((m) => m === "getSignatureStatuses")).toHaveLength(3);
    expect((await run({ node: { statuses: [{ err: null, confirmationStatus: "finalized" }] } })).result.kind).toBe("refunded");
  });
});

describe("the words for a refund and for a purchase", () => {
  it("name the same program error differently for each", () => {
    const wrongStatus = { InstructionError: [0, { Custom: 6000 + BREAKS_ERRORS.indexOf("WrongStatus") }] };
    expect(describeTransactionError(wrongStatus)).toBe("The sale of this break is over.");
    expect(describeTransactionError(wrongStatus, "buy")).toBe("The sale of this break is over.");
    expect(describeTransactionError(wrongStatus, "refund")).toBe("This break was not cancelled, so its spots are not refunded.");
    const paused = { InstructionError: [0, { Custom: 6000 + BREAKS_ERRORS.indexOf("Paused") }] };
    // Refunds always work, so a refund has no sentence about sales being paused: the error is just named.
    expect(describeTransactionError(paused, "refund")).toBe("The program refused it (Paused).");
  });
});
