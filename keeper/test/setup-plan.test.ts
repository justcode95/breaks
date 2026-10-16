import { describe, expect, it } from "vitest";
import { type ChainState, type ResolvedRequest, type Step, type StepState, NO_CONTROLLER, nextToSend, planSetup } from "../src/setup/plan.js";
import { treasuryAuthorityAddress } from "../src/solana/breaks.js";
import { associatedTokenAddress } from "../src/solana/pubkey.js";
import * as treasury from "../src/solana/treasury.js";
import { addr } from "./support/chain.js";
import { ADMIN_KEY, AUTHORITY, BUYER, KEEPER, USDC, setupWorld } from "./support/setup-world.js";
import { PROGRAMS } from "./support/world.js";

const CONTROLLER = treasuryAuthorityAddress(PROGRAMS);
const base = setupWorld().request();
const REQ: ResolvedRequest = { ...base, authority: AUTHORITY.address, admin: AUTHORITY.address, held: [AUTHORITY.address] };

const treasuryConfig = (over: Partial<treasury.TreasuryConfig> = {}): treasury.TreasuryConfig => ({
  admin: AUTHORITY.address,
  usdcMint: USDC,
  controller: NO_CONTROLLER,
  subsidyBps: 7_000,
  holderBps: 3_000,
  lockedSubsidy: 0n,
  lockedHolder: 0n,
  bump: 255,
  ...over,
});
const breaksConfig = (over: Partial<NonNullable<ChainState["breaks"]["value"]>> = {}): NonNullable<ChainState["breaks"]["value"]> => ({
  admin: AUTHORITY.address,
  keeper: KEEPER,
  buyer: BUYER,
  usdcMint: USDC,
  randomnessProgram: REQ.vrfProgram,
  randomnessTimeoutSecs: 600n,
  nextBreakId: 0n,
  minWindowSecs: 3_600n,
  maxWindowSecs: 21_600n,
  maxPaidSpots: 48,
  maxFreeSpots: 16,
  paused: false,
  bump: 255,
  ...over,
});

const FRESH: ChainState = {
  breaksProgram: { upgradeAuthority: AUTHORITY.address },
  treasuryProgram: { upgradeAuthority: AUTHORITY.address },
  mint: {},
  treasury: {},
  breaks: {},
  buyerUsdc: { exists: false },
  authorityLamports: 5_000_000_000n,
};
const ALL_DONE: ChainState = { ...FRESH, treasury: { value: treasuryConfig({ controller: CONTROLLER }) }, breaks: { value: breaksConfig() }, buyerUsdc: { exists: true } };

const kinds = (steps: Step[]) => steps.map((s) => s.state.kind);
const state = (steps: Step[], id: Step["id"]): StepState => (steps.find((s) => s.id === id) as Step).state;

describe("setup plan: a chain with nothing set up", () => {
  it("has four steps to do, in order, each after the one it needs", () => {
    const plan = planSetup(REQ, FRESH);
    expect(plan.steps.map((s) => s.id)).toEqual(["treasury-initialize", "breaks-initialize", "treasury-controller", "buyer-usdc"]);
    expect(kinds(plan.steps)).toEqual(["todo", "todo", "todo", "todo"]);
    expect((state(plan.steps, "treasury-initialize") as { after?: string }).after).toBeUndefined();
    expect((state(plan.steps, "breaks-initialize") as { after?: string }).after).toBe("treasury-initialize");
    expect((state(plan.steps, "treasury-controller") as { after?: string }).after).toBe("breaks-initialize");
    expect((state(plan.steps, "buyer-usdc") as { after?: string }).after).toBeUndefined();
    expect(plan.problems).toEqual([]);
  });

  it("builds the instructions the program builders build, with the right signer", () => {
    const plan = planSetup(REQ, FRESH);
    const t = state(plan.steps, "treasury-initialize");
    if (t.kind !== "todo") throw new Error("todo expected");
    expect(t.instruction).toEqual(treasury.initialize(PROGRAMS.treasury, { authority: AUTHORITY.address, usdcMint: USDC, admin: AUTHORITY.address, subsidyBps: 7_000, holderBps: 3_000 }));
    expect(t.signers).toEqual([AUTHORITY.address]);
    const c = state(plan.steps, "treasury-controller");
    if (c.kind !== "todo") throw new Error("todo expected");
    expect(c.instruction).toEqual(treasury.setController(PROGRAMS.treasury, { admin: AUTHORITY.address, controller: CONTROLLER }));
    // The authority is also the admin here, so it signs once and pays once.
    expect(c.signers).toEqual([AUTHORITY.address]);
    const b = state(plan.steps, "buyer-usdc");
    if (b.kind !== "todo") throw new Error("todo expected");
    expect(b.instruction.accounts[1]?.pubkey).toBe(associatedTokenAddress(BUYER, USDC));
    expect(b.instruction.accounts[0]).toMatchObject({ pubkey: AUTHORITY.address, isSigner: true, isWritable: true });
  });

  it("sends the steps one at a time: only the first is ready until it has landed", () => {
    const plan = planSetup(REQ, FRESH);
    expect(nextToSend(plan)?.id).toBe("treasury-initialize");
    const afterFirst = planSetup(REQ, { ...FRESH, treasury: { value: treasuryConfig() } });
    expect(nextToSend(afterFirst)?.id).toBe("breaks-initialize");
    const second: ChainState = { ...FRESH, treasury: { value: treasuryConfig() }, breaks: { value: breaksConfig() } };
    expect(nextToSend(planSetup(REQ, second))?.id).toBe("treasury-controller");
    const afterThird = planSetup(REQ, { ...second, treasury: { value: treasuryConfig({ controller: CONTROLLER }) } });
    expect(nextToSend(afterThird)?.id).toBe("buyer-usdc");
    expect(nextToSend(planSetup(REQ, ALL_DONE))).toBeUndefined();
  });

  it("needs, from the upgrade authority, the rent of every account it makes, the fees and what an account must keep, to the lamport", () => {
    // 1,760,880 (treasury config) + 2 x 2,039,280 (vaults) + 2,324,640 (breaks config) + 2,039,280 (buyer's USDC account)
    // + 4 transactions at 5,000 + 890,880 to keep = 11,114,240.
    const needed = 1_760_880n + 2n * 2_039_280n + 2_324_640n + 2_039_280n + 4n * 5_000n + 890_880n;
    expect(needed).toBe(11_114_240n);
    expect(planSetup(REQ, FRESH).needed).toBe(needed);
    expect(planSetup(REQ, { ...FRESH, authorityLamports: needed }).problems).toEqual([]);
    const short = planSetup(REQ, { ...FRESH, authorityLamports: needed - 1n });
    expect(short.problems).toEqual([expect.stringContaining(`holds ${needed - 1n} lamports and this needs ${needed}`)]);
  });

  it("needs only what is left to do: a finished setup needs nothing, whatever the wallet holds", () => {
    expect(planSetup(REQ, { ...ALL_DONE, authorityLamports: 0n })).toMatchObject({ needed: 0n, problems: [] });
    // Only the buyer's account left: its rent, one fee, and what to keep.
    const left = planSetup(REQ, { ...ALL_DONE, buyerUsdc: { exists: false } });
    expect(left.needed).toBe(2_039_280n + 5_000n + 890_880n);
  });

  it("charges the admin's signature too when the admin is another key that this run holds", () => {
    const req: ResolvedRequest = { ...REQ, admin: ADMIN_KEY.address, held: [AUTHORITY.address, ADMIN_KEY.address] };
    const plan = planSetup(req, FRESH);
    const c = state(plan.steps, "treasury-controller");
    if (c.kind !== "todo") throw new Error("todo expected");
    // The authority pays and signs first; the admin signs as well: two signatures, 10,000 lamports.
    expect(c.signers).toEqual([AUTHORITY.address, ADMIN_KEY.address]);
    expect(plan.needed).toBe(11_114_240n + 5_000n);
  });
});

describe("setup plan: the order of sending", () => {
  it("never sends a step before the one it waits for, whatever order the steps are listed in", () => {
    const todo = (after?: Step["id"]): StepState => ({
      kind: "todo",
      detail: "",
      instruction: { programId: PROGRAMS.treasury, accounts: [], data: new Uint8Array() },
      signers: [AUTHORITY.address],
      rent: 0n,
      ...(after ? { after } : {}),
    });
    const plan = (steps: Step[]) => ({ steps, problems: [], needed: 0n });
    const first: Step = { id: "treasury-initialize", title: "", state: todo() };
    const second: Step = { id: "breaks-initialize", title: "", state: todo("treasury-initialize") };
    expect(nextToSend(plan([second, first]))?.id).toBe("treasury-initialize");
    expect(nextToSend(plan([first, second]))?.id).toBe("treasury-initialize");
    // Once the first is in place, the second is ready.
    expect(nextToSend(plan([{ ...first, state: { kind: "done", detail: "" } }, second]))?.id).toBe("breaks-initialize");
    // A step waiting for something that is not done and not going to be (blocked) is not sent either.
    expect(nextToSend(plan([{ ...first, state: { kind: "blocked", reason: "x" } }, second]))).toBeUndefined();
  });
});

describe("setup plan: who may send what", () => {
  it("asks the admin to send set_controller when this run does not hold the admin's key, and says what to send", () => {
    const admin = addr(0xad);
    const req: ResolvedRequest = { ...REQ, admin };
    const plan = planSetup(req, { ...ALL_DONE, treasury: { value: treasuryConfig({ admin }) }, breaks: { value: breaksConfig({ admin }) } });
    const c = state(plan.steps, "treasury-controller");
    expect(c).toMatchObject({ kind: "needs-admin", admin });
    if (c.kind !== "needs-admin") throw new Error("needs-admin expected");
    expect(c.instruction).toEqual(treasury.setController(PROGRAMS.treasury, { admin, controller: CONTROLLER }));
    // It is not counted as something this run will send or pay for.
    expect(plan.needed).toBe(0n);
    expect(nextToSend(plan)).toBeUndefined();
  });

  it("uses the admin the treasury has on chain, not the one asked for, because that is the one that can sign", () => {
    const plan = planSetup(REQ, { ...ALL_DONE, treasury: { value: treasuryConfig({ admin: ADMIN_KEY.address }) } });
    expect(state(plan.steps, "treasury-controller")).toMatchObject({ kind: "needs-admin", admin: ADMIN_KEY.address });
    expect(state(plan.steps, "treasury-initialize").kind).toBe("differs");
  });

  it("blocks an initialize when the key is not the program's upgrade authority, naming who is", () => {
    const other = addr(0xee);
    const plan = planSetup(REQ, { ...FRESH, treasuryProgram: { upgradeAuthority: other }, breaksProgram: { upgradeAuthority: other } });
    expect(state(plan.steps, "treasury-initialize")).toEqual({
      kind: "blocked",
      reason: `the treasury program's upgrade authority is ${other}, not ${AUTHORITY.address}: only the upgrade authority can initialize it (give --authority-keypair for that address)`,
    });
    expect(state(plan.steps, "breaks-initialize")).toMatchObject({ kind: "blocked", reason: expect.stringContaining(`the breaks program's upgrade authority is ${other}`) });
    // Nothing downstream can be done either.
    expect(state(plan.steps, "treasury-controller").kind).toBe("blocked");
    expect(nextToSend(plan)?.id).toBe("buyer-usdc");
  });

  it("blocks an initialize on a program that can no longer be upgraded, or is not there, or is not a program", () => {
    expect(state(planSetup(REQ, { ...FRESH, treasuryProgram: { upgradeAuthority: null } }).steps, "treasury-initialize")).toMatchObject({ kind: "blocked", reason: expect.stringContaining("can no longer be upgraded") });
    expect(state(planSetup(REQ, { ...FRESH, treasuryProgram: { problem: "does not exist on this network: is it deployed, and is the program id right?" } }).steps, "treasury-initialize")).toEqual({
      kind: "blocked",
      reason: "the treasury program does not exist on this network: is it deployed, and is the program id right?",
    });
    // An already initialized treasury needs no authority at all, even if the program is frozen now.
    expect(state(planSetup(REQ, { ...ALL_DONE, treasuryProgram: { upgradeAuthority: null } }).steps, "treasury-initialize").kind).toBe("done");
  });

  it("will not initialize anything with a USDC mint that is not usable, but still says so once", () => {
    const plan = planSetup(REQ, { ...FRESH, mint: { problem: `${USDC} has 9 decimals; USDC has 6, and the programs count in USDC's base units` } });
    expect(state(plan.steps, "treasury-initialize")).toMatchObject({ kind: "blocked", reason: expect.stringContaining("has 9 decimals") });
    expect(state(plan.steps, "buyer-usdc")).toMatchObject({ kind: "blocked", reason: expect.stringContaining("has 9 decimals") });
  });

  it("blocks the breaks program while the treasury cannot be initialized, because it takes the treasury's mint", () => {
    const plan = planSetup(REQ, { ...FRESH, treasuryProgram: { upgradeAuthority: addr(0xee) } });
    expect(state(plan.steps, "breaks-initialize")).toEqual({ kind: "blocked", reason: "the treasury has to be initialized first, and it cannot be (see step 1)" });
  });

  it("blocks the breaks program when the treasury is on chain with another mint", () => {
    const plan = planSetup(REQ, { ...FRESH, treasury: { value: treasuryConfig({ usdcMint: addr(0xd0) }) } });
    expect(state(plan.steps, "treasury-initialize").kind).toBe("differs");
    expect(state(plan.steps, "breaks-initialize")).toMatchObject({ kind: "blocked", reason: expect.stringContaining(`the treasury uses the USDC mint ${addr(0xd0)}, not ${USDC}`) });
  });

  it("reports an account that is there but wrong as a problem of that step", () => {
    const plan = planSetup(REQ, { ...FRESH, treasury: { problem: "XYZ is owned by someone else" }, breaks: { problem: "ABC could not be read: too short" } });
    expect(state(plan.steps, "treasury-initialize")).toEqual({ kind: "blocked", reason: "the treasury's config account XYZ is owned by someone else" });
    expect(state(plan.steps, "breaks-initialize")).toEqual({ kind: "blocked", reason: "the breaks program's config account ABC could not be read: too short" });
  });
});

describe("setup plan: what is already there", () => {
  it("is done when everything is on chain as asked, and says what it found", () => {
    const plan = planSetup(REQ, ALL_DONE);
    expect(kinds(plan.steps)).toEqual(["done", "done", "done", "done"]);
    expect(state(plan.steps, "treasury-initialize")).toMatchObject({ detail: expect.stringContaining("split 70% subsidy / 30% holder") });
    expect(state(plan.steps, "treasury-controller")).toMatchObject({ detail: expect.stringContaining(CONTROLLER) });
    expect(plan.problems).toEqual([]);
  });

  it("names each difference in the treasury, with what could change it, and never plans to overwrite", () => {
    const plan = planSetup(REQ, { ...ALL_DONE, treasury: { value: treasuryConfig({ admin: addr(1), usdcMint: addr(2), subsidyBps: 5_000, holderBps: 5_000, controller: CONTROLLER }) } });
    const s = state(plan.steps, "treasury-initialize");
    expect(s).toEqual({
      kind: "differs",
      differences: [
        `admin: on chain ${addr(1)}, asked for ${AUTHORITY.address} (the treasury has no way to hand the admin over yet)`,
        `USDC mint: on chain ${addr(2)}, asked for ${USDC} (set at initialization, cannot be changed: deploy again)`,
        "split: on chain 50% subsidy / 50% holder, asked for 70% / 30% (the admin can change it with set_split)",
      ],
    });
    expect(nextToSend(plan)).toBeUndefined();
  });

  it("names each difference in the breaks program, and which of them the admin can still change", () => {
    const wrong = breaksConfig({
      admin: addr(1),
      keeper: addr(2),
      buyer: addr(3),
      usdcMint: addr(4),
      randomnessProgram: addr(5),
      randomnessTimeoutSecs: 300n,
      minWindowSecs: 60n,
      maxWindowSecs: 120n,
      maxPaidSpots: 10,
      maxFreeSpots: 2,
    });
    const s = state(planSetup(REQ, { ...ALL_DONE, breaks: { value: wrong } }).steps, "breaks-initialize");
    if (s.kind !== "differs") throw new Error("differs expected");
    expect(s.differences).toEqual([
      `admin: on chain ${addr(1)}, asked for ${AUTHORITY.address} (there is no way to hand the admin over yet)`,
      `keeper: on chain ${addr(2)}, asked for ${KEEPER} (the admin can change it with set_keeper)`,
      `buyer wallet: on chain ${addr(3)}, asked for ${BUYER} (the admin can change it with set_buyer)`,
      `USDC mint: on chain ${addr(4)}, asked for ${USDC} (set at initialization, cannot be changed: deploy again)`,
      `randomness program: on chain ${addr(5)}, asked for ${REQ.vrfProgram} (the admin can change it with set_randomness)`,
      "randomness timeout: on chain 300 s, asked for 600 s (the admin can change it with set_randomness)",
      "sale window: on chain 60 to 120 s, asked for 3600 to 21600 s (set at initialization, cannot be changed: deploy again)",
      "spot limits: on chain 10 paid and 2 free, asked for 48 paid and 16 free (set at initialization, cannot be changed: deploy again)",
    ]);
  });

  it("sees one changed value at a time", () => {
    for (const [over, text] of [
      [{ keeper: addr(2) }, "keeper:"],
      [{ buyer: addr(3) }, "buyer wallet:"],
      [{ randomnessTimeoutSecs: 601n }, "randomness timeout:"],
      [{ minWindowSecs: 3_601n }, "sale window:"],
      [{ maxWindowSecs: 21_599n }, "sale window:"],
      [{ maxPaidSpots: 47 }, "spot limits:"],
      [{ maxFreeSpots: 15 }, "spot limits:"],
    ] as const) {
      const s = state(planSetup(REQ, { ...ALL_DONE, breaks: { value: breaksConfig(over) } }).steps, "breaks-initialize");
      expect(s, text).toMatchObject({ kind: "differs", differences: [expect.stringContaining(text)] });
    }
    // A paused program is not something setup asks for or against.
    expect(state(planSetup(REQ, { ...ALL_DONE, breaks: { value: breaksConfig({ paused: true }) } }).steps, "breaks-initialize").kind).toBe("done");
  });

  it("does not replace a controller that is set to something else", () => {
    const other = addr(0x99);
    const s = state(planSetup(REQ, { ...ALL_DONE, treasury: { value: treasuryConfig({ controller: other }) } }).steps, "treasury-controller");
    expect(s).toEqual({
      kind: "differs",
      differences: [`controller: on chain ${other}, the breaks program's authority is ${CONTROLLER} (this tool does not replace a controller that is set; the admin can with set_controller)`],
    });
  });

  it("takes an unset controller (the all-zero address) as a step to do, and the right one as done", () => {
    expect(state(planSetup(REQ, { ...ALL_DONE, treasury: { value: treasuryConfig({ controller: NO_CONTROLLER }) } }).steps, "treasury-controller").kind).toBe("todo");
    expect(state(planSetup(REQ, ALL_DONE).steps, "treasury-controller").kind).toBe("done");
  });

  it("blocks the controller until the breaks program is initialized, and when it cannot be", () => {
    const noBreaks = planSetup(REQ, { ...FRESH, treasury: { value: treasuryConfig() }, breaksProgram: { upgradeAuthority: addr(0xee) } });
    expect(state(noBreaks.steps, "treasury-controller")).toEqual({ kind: "blocked", reason: "the breaks program is not initialized (see step 2)" });
    // A breaks program that is on chain but with other values still lets the controller be appointed.
    const differs = planSetup(REQ, { ...ALL_DONE, treasury: { value: treasuryConfig() }, breaks: { value: breaksConfig({ keeper: addr(2) }) } });
    expect(state(differs.steps, "treasury-controller").kind).toBe("todo");
  });

  it("checks the buyer's USDC account", () => {
    expect(state(planSetup(REQ, { ...ALL_DONE, buyerUsdc: { exists: true, problem: "belongs to another mint or owner than its address says" } }).steps, "buyer-usdc")).toEqual({
      kind: "blocked",
      reason: `the buyer's USDC account ${associatedTokenAddress(BUYER, USDC)} belongs to another mint or owner than its address says`,
    });
    expect(state(planSetup(REQ, ALL_DONE).steps, "buyer-usdc")).toEqual({ kind: "done", detail: `${associatedTokenAddress(BUYER, USDC)} exists` });
  });
});

describe("setup plan: the roles", () => {
  it("refuses a keeper that is the admin or the upgrade authority, and a buyer that is any of the three", () => {
    const problems = (over: Partial<ResolvedRequest>) => planSetup({ ...REQ, ...over }, FRESH).problems;
    expect(problems({ keeper: AUTHORITY.address })).toEqual(
      expect.arrayContaining(["the keeper's address is the admin: the keeper is a hot wallet and must not be able to change the configuration", "the keeper's address is the upgrade authority: the keeper must not be able to replace the programs"]),
    );
    expect(problems({ keeper: addr(0xad), admin: addr(0xad) })).toEqual(["the keeper's address is the admin: the keeper is a hot wallet and must not be able to change the configuration"]);
    for (const buyer of [AUTHORITY.address, addr(0xad), KEEPER]) {
      expect(problems({ buyer, admin: addr(0xad) }), buyer).toContain("the buyer wallet is also the admin, the upgrade authority or the keeper: it holds the pack budget and must have no authority over anything");
    }
    expect(problems({})).toEqual([]);
  });
});
