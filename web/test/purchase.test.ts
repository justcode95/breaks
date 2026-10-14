import { readFileSync } from "node:fs";
import { join } from "node:path";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { type Address, TOKEN_PROGRAM, associatedTokenAddress, breakAddress, configAddress } from "../lib/chain/address";
import { buySpotInstruction } from "../lib/chain/buy";
import { GENESIS_HASHES } from "../lib/chain/cluster";
import { BREAKS_ERRORS, type PurchaseResult, type PurchaseStep, SPOT_ACCOUNT_BYTES, buySpot, describeTransactionError } from "../lib/chain/purchase";
import { buildTransaction } from "../lib/chain/transaction";
import { fromHex } from "../lib/draw/bytes";
import { type BreakFields, type ConfigFields, type Served, breakFieldsFromVector, configFieldsFromVector, encodeBreak, encodeConfig, encodeTokenAccount } from "./support/accounts";
import { decodeMessage, summary } from "./support/message";
import { type NodeScript, rpcNode } from "./support/node";
import { fill, pretendAccount, pretendWallet } from "./support/wallet";

const vectors: { programs: { breaks: string }; cases: { name: string; inputs: Record<string, any>; outputs?: Record<string, any> | null }[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "instruction-vectors.json"), "utf8"),
);
const named = (n: string) => vectors.cases.find((c) => c.name === n) as { inputs: Record<string, any>; outputs?: Record<string, any> | null };
const PROGRAM = vectors.programs.breaks;
const CONFIG: ConfigFields = { ...configFieldsFromVector(named("breaks.account.BreaksConfig").outputs as Record<string, any>), paused: false };
const SAMPLE = breakFieldsFromVector(named("breaks.account.Break").outputs as Record<string, any>);
// The sample's sale window: 2027-01-15 08:00 to 14:00 UTC. The sample break is break number 8 (id 7).
const OPENS = 1_800_000_000;
const NUMBER = Number(SAMPLE.id) + 1;
const BLOCKHASH = base58.encode(new Uint8Array(32).fill(9));
const BUYER = fill(5);
const BUYER_USDC = associatedTokenAddress(BUYER, CONFIG.usdcMint);

function world(over: { config?: Partial<ConfigFields>; brk?: Partial<BreakFields> | null; usdc?: bigint | null } = {}): Map<Address, Served> {
  const accounts = new Map<Address, Served>();
  accounts.set(configAddress(PROGRAM), { data: encodeConfig({ ...CONFIG, ...over.config }), owner: PROGRAM });
  if (over.brk !== null) accounts.set(breakAddress(PROGRAM, SAMPLE.id), { data: encodeBreak({ ...SAMPLE, status: "Open", spotsSold: 3, freeWinnerCount: 0, freeWinners: [], ...over.brk }), owner: PROGRAM });
  if (over.usdc !== null) accounts.set(BUYER_USDC, { data: encodeTokenAccount({ mint: CONFIG.usdcMint, owner: BUYER, amount: over.usdc ?? 25_000_000n }), owner: TOKEN_PROGRAM });
  return accounts;
}

interface Setup {
  world?: Parameters<typeof world>[0];
  node?: Partial<NodeScript>;
  wallet?: Parameters<typeof pretendWallet>[0];
  now?: number;
  timeoutMs?: number;
}

async function run(s: Setup = {}) {
  const node = rpcNode({ accounts: world(s.world), blockhash: BLOCKHASH, statuses: [{ err: null, confirmationStatus: "confirmed" }], ...s.node });
  const wallet = pretendWallet({ name: "Pretend", accounts: [pretendAccount(5)], ...s.wallet });
  const steps: PurchaseStep[] = [];
  let t = 0;
  const result: PurchaseResult = await buySpot({
    rpcUrl: "http://node.test",
    program: PROGRAM,
    breakNumber: NUMBER,
    wallet,
    account: pretendAccount(5),
    fetch: node.fetchFn,
    now: () => s.now ?? OPENS + 3600,
    clock: () => t,
    sleep: async (ms) => void (t += ms),
    confirmTimeoutMs: s.timeoutMs ?? 10_000,
    pollMs: 1000,
    onStep: (step) => steps.push(step),
  });
  return { result, node, wallet, steps, elapsed: t };
}

describe("buying a spot", () => {
  it("checks everything, asks the wallet once to sign and send the right transaction, and waits for the network to confirm", async () => {
    const { result, node, wallet, steps } = await run();
    expect(result).toEqual({ kind: "bought", signature: base58.encode(new Uint8Array(64).fill(7)), index: 3, price: 20_000_000n });
    expect(steps).toEqual(["checking", "waiting-for-wallet", "confirming"]);

    expect(wallet.sendCalls).toHaveLength(1);
    const call = wallet.sendCalls[0];
    expect(call?.chain).toBe("solana:devnet");
    expect(call?.account.address).toBe(BUYER);
    const expected = buildTransaction({
      feePayer: BUYER,
      recentBlockhash: BLOCKHASH,
      instructions: [buySpotInstruction({ program: PROGRAM, buyer: BUYER, buyerUsdc: BUYER_USDC, breakId: SAMPLE.id, index: 3 })],
    });
    // What the wallet was given is the buy_spot transaction for the next spot, with an empty signature slot for it to fill.
    expect(call?.transaction).toEqual(expected.unsigned);
    expect(summary(decodeMessage((call?.transaction as Uint8Array).slice(65)))).toEqual(summary(decodeMessage(expected.message)));

    // The money and the blockhash are read at the same commitment as the accounts.
    expect(node.calls.find((c) => c.method === "getLatestBlockhash")?.params).toEqual([{ commitment: "confirmed" }]);
    expect(node.calls.find((c) => c.method === "getBalance")?.params).toEqual([BUYER, { commitment: "confirmed" }]);
    // The network was asked which network it is before anything else; the wallet did the sending, not this page.
    expect(node.methods()[0]).toBe("getGenesisHash");
    expect(node.methods()).not.toContain("sendTransaction");
    for (const c of node.calls.filter((c) => c.method === "getMultipleAccounts")) expect((c.params[1] as { commitment: string }).commitment).toBe("confirmed");
  });

  it("is told the number of the break and the id is one less", async () => {
    const { node } = await run();
    const reads = node.calls.filter((c) => c.method === "getMultipleAccounts")[0];
    expect(reads?.params[0]).toEqual([configAddress(PROGRAM), breakAddress(PROGRAM, SAMPLE.id)]);
  });

  it("refuses, without asking the wallet, on any network that is not devnet", async () => {
    for (const [genesis, words] of [
      [GENESIS_HASHES["mainnet-beta"], "mainnet"],
      [GENESIS_HASHES.testnet, "testnet"],
      ["11111111111111111111111111111111", "not Solana devnet"],
    ] as const) {
      const { result, wallet, node } = await run({ node: { genesis } });
      expect(result.kind, words).toBe("refused");
      expect((result as { reason: string }).reason).toContain(words);
      expect((result as { reason: string }).reason).toContain("nothing was sent");
      expect(wallet.sendCalls).toHaveLength(0);
      expect(node.methods()).toEqual(["getGenesisHash"]);
    }
  });

  it("refuses when the node cannot say which network it is, or cannot be read for the purchase", async () => {
    const unsure = await run({ node: { failing: ["getGenesisHash"] } });
    expect(unsure.result).toMatchObject({ kind: "refused" });
    expect((unsure.result as { reason: string }).reason).toContain("Could not check which network the node is on");
    for (const method of ["getMultipleAccounts", "getBalance", "getMinimumBalanceForRentExemption", "getLatestBlockhash"]) {
      const r = await run({ node: { failing: [method] } });
      expect(r.result.kind, method).toBe("refused");
      expect((r.result as { reason: string }).reason, method).toContain("nothing was sent");
      expect(r.wallet.sendCalls, method).toHaveLength(0);
    }
  });

  it("refuses a break that is missing, a program that is not set up and accounts that are not the program's", async () => {
    const reason = async (s: Setup) => (await run(s)).result as { kind: string; reason: string };
    expect(await reason({ world: { brk: null } })).toMatchObject({ kind: "refused", reason: `Break #${NUMBER} does not exist, so nothing was sent.` });
    const noConfig = world();
    noConfig.delete(configAddress(PROGRAM));
    expect((await reason({ node: { accounts: noConfig } })).reason).toContain("has not been set up on this network");
    const foreign = world();
    foreign.set(breakAddress(PROGRAM, SAMPLE.id), { ...(foreign.get(breakAddress(PROGRAM, SAMPLE.id)) as Served), owner: fill(9) });
    expect((await reason({ node: { accounts: foreign } })).reason).toContain("not owned by the breaks program");
    const short = world();
    short.set(breakAddress(PROGRAM, SAMPLE.id), { data: new Uint8Array(20), owner: PROGRAM });
    expect((await reason({ node: { accounts: short } })).reason).toContain("could not be read");
    // An account that decodes but is another break.
    const other = world({ brk: { id: 99n } });
    expect((await reason({ node: { accounts: other } })).reason).toContain("says it is another break");
    // With nothing wrong, the same setup buys.
    expect((await run()).result.kind).toBe("bought");
  });

  it("refuses a break that cannot be bought now, with the program's own reasons", async () => {
    const reason = async (s: Setup) => ((await run(s)).result as { reason: string }).reason;
    expect(await reason({ world: { config: { paused: true } } })).toBe("Sales are paused by the program's admin.");
    expect(await reason({ world: { brk: { status: "Closed" } } })).toBe("The sale of this break is over.");
    expect(await reason({ now: OPENS - 5 })).toContain("The sale opens");
    expect(await reason({ now: OPENS + 6 * 3600 })).toBe("The sale has ended.");
    expect(await reason({ world: { brk: { spotsSold: 10 } } })).toBe("All paid spots are taken.");
  });

  it("refuses a wallet that cannot pay in USDC, with the amounts", async () => {
    const reason = async (s: Setup) => ((await run(s)).result as { reason: string }).reason;
    expect(await reason({ world: { usdc: 19_999_999n } })).toBe("A spot costs $20 USDC and this wallet has $19.999999.");
    expect(await reason({ world: { usdc: null } })).toContain("no USDC account yet");
    expect((await run({ world: { usdc: 20_000_000n } })).result.kind).toBe("bought");
  });

  it("refuses a wallet that cannot pay in SOL for the new account, the fee and what a wallet must keep", async () => {
    // 1,308,480 for the spot account + 5,000 for the fee + 890,880 for the wallet to stay a valid account.
    const need = 1_308_480 + 5_000 + 890_880;
    const short = await run({ node: { lamports: need - 1 } });
    expect(short.result).toMatchObject({ kind: "refused", reason: "This wallet needs about 0.00220436 SOL for the new spot's account and the network fee, and has 0.002204359 SOL." });
    expect(short.wallet.sendCalls).toHaveLength(0);
    expect((await run({ node: { lamports: need } })).result.kind).toBe("bought");
    // The rent comes from the node, not from a number in the page.
    const dearer = await run({ node: { lamports: need, rent: { spot: 1_308_481, bare: 890_880 } } });
    expect(dearer.result.kind).toBe("refused");
    const rentCalls = (await run()).node.calls.filter((c) => c.method === "getMinimumBalanceForRentExemption").map((c) => c.params[0]);
    expect(rentCalls.sort()).toEqual([0, SPOT_ACCOUNT_BYTES]);
  });

  it("says the wallet declined, with a warning to look at its history first, when the wallet fails or gives nothing back", async () => {
    const declined = async (wallet: Setup["wallet"]) => (await run({ wallet })).result as { kind: string; reason: string };
    const rejected = await declined({ send: async () => Promise.reject(new Error("User rejected the request.")) });
    expect(rejected).toEqual({ kind: "declined", reason: "Pretend did not send the transaction: User rejected the request.. If you approved it, check your wallet's history before trying again." });
    expect((await declined({ send: async () => [] })).reason).toContain("did not give back a transaction signature");
    expect((await declined({ send: async () => [{ signature: new Uint8Array(10) }] })).reason).toContain("did not give back a transaction signature");
    const noSend = await declined({ only: ["connect"] });
    expect(noSend).toEqual({ kind: "declined", reason: "Pretend cannot send Solana transactions." });
  });
});

describe("waiting for the network", () => {
  const sig = base58.encode(new Uint8Array(64).fill(7));
  const confirmed = { err: null, confirmationStatus: "confirmed" };

  it("polls until the network has the transaction, and accepts confirmed and finalized, not processed", async () => {
    const waited = await run({ node: { statuses: [null, null, { err: null, confirmationStatus: "processed" }, confirmed] } });
    expect(waited.result.kind).toBe("bought");
    expect(waited.node.methods().filter((m) => m === "getSignatureStatuses")).toHaveLength(4);
    expect(waited.elapsed).toBe(3000);
    expect((await run({ node: { statuses: [{ err: null, confirmationStatus: "finalized" }] } })).result.kind).toBe("bought");
  });

  it("asks about this transaction only, and not the history", async () => {
    const { node } = await run();
    expect(node.calls.find((c) => c.method === "getSignatureStatuses")?.params).toEqual([[sig], { searchTransactionHistory: false }]);
  });

  it("says in words why the network refused a transaction that landed", async () => {
    const failed = async (err: unknown) => (await run({ node: { statuses: [{ err, confirmationStatus: "confirmed" }] } })).result as { kind: string; reason: string; signature: string };
    const taken = await failed({ InstructionError: [0, { Custom: 6012 }] });
    expect(taken).toEqual({ kind: "failed", signature: sig, reason: "Someone else took that spot first. Read the break again and try once more." });
    expect((await failed({ InstructionError: [0, { Custom: 6011 }] })).reason).toBe("All paid spots are taken.");
  });

  it("keeps asking through a node that fails now and then", async () => {
    const r = await run({ node: { statuses: ["fail", "fail", confirmed] } });
    expect(r.result.kind).toBe("bought");
  });

  it("gives up after the time allowed, and says the transaction may still land", async () => {
    const r = await run({ node: { statuses: [null] }, timeoutMs: 5000 });
    expect(r.result).toMatchObject({ kind: "unconfirmed", signature: sig });
    expect((r.result as { reason: string }).reason).toContain("It may still land");
    expect(r.elapsed).toBe(5000);
    // With a node that fails all that time, it says so as well.
    const down = await run({ node: { statuses: ["fail"] }, timeoutMs: 3000 });
    expect(down.result).toMatchObject({ kind: "unconfirmed" });
    expect((down.result as { reason: string }).reason).toContain("The last attempt to ask the network failed");
  });

  it("says nothing was bought once the chain is past the last block the transaction could land in", async () => {
    // Checked every fourth poll: the height is 1001 and the last valid block is 1000.
    const r = await run({ node: { statuses: [null], lastValidBlockHeight: 1000, heights: [1001] }, timeoutMs: 60_000 });
    expect(r.result).toEqual({ kind: "failed", signature: sig, reason: "The transaction expired before it landed, so nothing was bought. You can try again." });
    expect(r.node.methods().filter((m) => m === "getBlockHeight")).toHaveLength(1);
    expect(r.node.methods().filter((m) => m === "getSignatureStatuses")).toHaveLength(4);
    // At the last valid block it can still land, so it keeps waiting.
    const still = await run({ node: { statuses: [null], lastValidBlockHeight: 1000, heights: [1000] }, timeoutMs: 6000 });
    expect(still.result.kind).toBe("unconfirmed");
  });
});

describe("what a failed transaction says", () => {
  it("names the program's errors, in the order of the Rust enum", () => {
    const rust = readFileSync(join(import.meta.dirname, "..", "..", "programs", "breaks", "src", "errors.rs"), "utf8");
    const body = rust.slice(rust.indexOf("pub enum BreaksError {"));
    const names = [...body.matchAll(/^\s+([A-Z][A-Za-z]+),$/gm)].map((m) => m[1]);
    expect([...BREAKS_ERRORS]).toEqual(names);
  });

  const custom = (code: number) => ({ InstructionError: [0, { Custom: code }] });

  it("says what a purchase can run into, and names the other errors of the program", () => {
    const code = (name: (typeof BREAKS_ERRORS)[number]) => 6000 + BREAKS_ERRORS.indexOf(name);
    expect(describeTransactionError(custom(code("Paused")))).toBe("Sales are paused by the program's admin.");
    expect(describeTransactionError(custom(code("WrongStatus")))).toBe("The sale of this break is over.");
    expect(describeTransactionError(custom(code("NotInSaleWindow")))).toBe("The sale is not open (it has not started, or it has ended).");
    expect(describeTransactionError(custom(code("SoldOut")))).toBe("All paid spots are taken.");
    expect(describeTransactionError(custom(code("WrongSpotIndex")))).toBe("Someone else took that spot first. Read the break again and try once more.");
    expect(describeTransactionError(custom(code("InvalidProof")))).toBe("The program refused it (InvalidProof).");
    expect(describeTransactionError(custom(6000 + BREAKS_ERRORS.length))).toBe(`The network refused it (${JSON.stringify(custom(6000 + BREAKS_ERRORS.length))}).`);
  });

  it("says what the two small numbers of the token and system programs most likely mean", () => {
    expect(describeTransactionError(custom(0))).toContain("probably just taken by someone else");
    expect(describeTransactionError(custom(1))).toContain("too little USDC or SOL");
    expect(describeTransactionError({ InstructionError: [0, "InsufficientFunds"] })).toContain("too little USDC or SOL");
    expect(describeTransactionError(custom(5))).toBe(`The network refused it (${JSON.stringify(custom(5))}).`);
  });

  it("says what the network's own transaction errors mean", () => {
    expect(describeTransactionError("BlockhashNotFound")).toBe("The transaction was too old (its blockhash expired). Nothing was bought; try again.");
    expect(describeTransactionError("InsufficientFundsForFee")).toContain("enough SOL");
    expect(describeTransactionError("InsufficientFundsForRent")).toContain("enough SOL");
    expect(describeTransactionError({ InsufficientFundsForRent: { account_index: 0 } })).toContain("enough SOL");
    expect(describeTransactionError("AccountNotFound")).toBe("The wallet has no SOL, so it cannot pay the network fee.");
    expect(describeTransactionError("SomethingNew")).toBe("The network refused it (SomethingNew).");
    expect(describeTransactionError({ weird: "x".repeat(300) })).toMatch(/^The network refused it \(.{199}…\)\.$/);
    expect(describeTransactionError(undefined)).toBe("The network refused it (undefined).");
  });
});

describe("the size of a spot account", () => {
  it("is the size of the Rust program's own sample Spot account", () => {
    const data = named("breaks.account.Spot").inputs.data as string;
    expect(fromHex(data).length).toBe(SPOT_ACCOUNT_BYTES);
  });
});
