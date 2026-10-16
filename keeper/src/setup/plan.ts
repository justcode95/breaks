// What setup has to do, worked out from what the request asks for and what the chain holds. Pure: no node, no key.
//
// Four steps, each one looking at its own account first:
//   1. the treasury's `initialize`          signed by the treasury program's upgrade authority
//   2. the breaks program's `initialize`    signed by the breaks program's upgrade authority
//   3. the treasury's `set_controller`      signed by the treasury's admin (the controller is the breaks program's authority PDA)
//   4. the buyer wallet's USDC account      paid for by the upgrade authority
// A step is `done` when its account is there and says what was asked, `todo` when it is missing and can be made, `differs` when
// it is there and says something else (this tool never overwrites: `initialize` cannot be repeated, and a changed value is the
// admin's decision), `blocked` when it cannot be done from here, and `needs-admin` when only the admin can send it.

import * as breaks from "../solana/breaks.js";
import { type Instruction } from "../solana/instruction.js";
import { createAssociatedTokenAccountIdempotent } from "../solana/associated-token.js";
import { type Address, associatedTokenAddress } from "../solana/pubkey.js";
import {
  BREAKS_CONFIG_ACCOUNT_BYTES,
  SIGNATURE_FEE,
  TOKEN_ACCOUNT_BYTES,
  TREASURY_CONFIG_ACCOUNT_BYTES,
  rentExempt,
} from "../solana/rent.js";
import * as treasury from "../solana/treasury.js";
import type { SetupRequest } from "./args.js";

/** An unset controller in the treasury's config is the all-zero address, which is the system program's. */
export const NO_CONTROLLER: Address = "11111111111111111111111111111111";

/** The request with the two addresses that come from keys filled in. */
export interface ResolvedRequest extends Omit<SetupRequest, "admin"> {
  /** The upgrade authority: signs the two `initialize` calls and pays for everything. */
  authority: Address;
  admin: Address;
  /** Addresses whose keys this run holds. */
  held: readonly Address[];
}

export interface ProgramState {
  /** Why the program cannot be used (missing, not an upgradeable program). */
  problem?: string;
  /** Who may upgrade it: an address, or null once it is immutable. */
  upgradeAuthority?: Address | null;
}

/** An account the tool reads: absent, present and readable, or present and wrong (`problem` says how). */
export interface Slot<T> {
  value?: T;
  problem?: string;
}

export interface ChainState {
  breaksProgram: ProgramState;
  treasuryProgram: ProgramState;
  mint: { problem?: string };
  treasury: Slot<treasury.TreasuryConfig>;
  breaks: Slot<breaks.BreaksConfigAccount>;
  buyerUsdc: { exists: boolean; problem?: string };
  /** What the upgrade authority holds, in lamports. */
  authorityLamports: bigint;
}

export type StepId = "treasury-initialize" | "breaks-initialize" | "treasury-controller" | "buyer-usdc";

export type StepState =
  | { kind: "done"; detail: string }
  | {
      kind: "todo";
      detail: string;
      instruction: Instruction;
      /** Who signs, the fee payer (the upgrade authority) first. */
      signers: Address[];
      /** Rent of the accounts it makes. */
      rent: bigint;
      /** The step that has to land first, if it has not yet. */
      after?: StepId;
    }
  | { kind: "needs-admin"; detail: string; instruction: Instruction; admin: Address; after?: StepId }
  | { kind: "differs"; differences: string[] }
  | { kind: "blocked"; reason: string };

export interface Step {
  id: StepId;
  title: string;
  state: StepState;
}

export interface Plan {
  steps: Step[];
  /** Things that stop anything from being sent (the key does not fit the roles, not enough SOL). Steps are still listed. */
  problems: string[];
  /** The least the upgrade authority must hold to do every `todo` step. */
  needed: bigint;
}

export const STEP_ORDER: readonly StepId[] = ["treasury-initialize", "breaks-initialize", "treasury-controller", "buyer-usdc"];

const TITLES: Record<StepId, string> = {
  "treasury-initialize": "The treasury is initialized",
  "breaks-initialize": "The breaks program is initialized",
  "treasury-controller": "The treasury's controller is the breaks program",
  "buyer-usdc": "The buyer wallet has a USDC account",
};

const same = (a: Address, b: Address) => a === b;
const pct = (bps: number) => `${bps / 100}%`;

/** A difference between what is on chain and what was asked, with what could change it. */
function differ(name: string, onChain: string, wanted: string, remedy: string): string {
  return `${name}: on chain ${onChain}, asked for ${wanted} (${remedy})`;
}

/** Why a program cannot take its `initialize` from this key, if it cannot. */
function programBlock(label: string, p: ProgramState, authority: Address): string | undefined {
  if (p.problem) return `the ${label} program ${p.problem}`;
  if (p.upgradeAuthority === null) return `the ${label} program can no longer be upgraded, so nobody can initialize it`;
  if (p.upgradeAuthority !== undefined && !same(p.upgradeAuthority, authority)) {
    return `the ${label} program's upgrade authority is ${p.upgradeAuthority}, not ${authority}: only the upgrade authority can initialize it (give --authority-keypair for that address)`;
  }
  return undefined;
}

export function planSetup(req: ResolvedRequest, state: ChainState): Plan {
  const { programs, authority, admin } = req;
  const controller = breaks.treasuryAuthorityAddress(programs);
  const held = (a: Address) => req.held.includes(a);
  const problems: string[] = [];

  // The roles: the guardrails keep the hot wallets away from any authority.
  if (same(req.keeper, admin)) problems.push("the keeper's address is the admin: the keeper is a hot wallet and must not be able to change the configuration");
  if (same(req.keeper, authority)) problems.push("the keeper's address is the upgrade authority: the keeper must not be able to replace the programs");
  if (same(req.buyer, admin) || same(req.buyer, authority) || same(req.buyer, req.keeper)) {
    problems.push("the buyer wallet is also the admin, the upgrade authority or the keeper: it holds the pack budget and must have no authority over anything");
  }

  const steps: Step[] = [];
  const push = (id: StepId, state: StepState) => steps.push({ id, title: TITLES[id], state });

  // ------------------------------------------------------------ 1. the treasury
  const t = state.treasury.value;
  let treasuryStep: StepState;
  if (state.treasury.problem) {
    treasuryStep = { kind: "blocked", reason: `the treasury's config account ${state.treasury.problem}` };
  } else if (t) {
    const d: string[] = [];
    if (!same(t.admin, admin)) d.push(differ("admin", t.admin, admin, "the treasury has no way to hand the admin over yet"));
    if (!same(t.usdcMint, req.usdcMint)) d.push(differ("USDC mint", t.usdcMint, req.usdcMint, "set at initialization, cannot be changed: deploy again"));
    // The two shares always add up to 10,000 (the program checks it, and so does the command line), so one of them says it all.
    if (t.subsidyBps !== req.subsidyBps) {
      d.push(differ("split", `${pct(t.subsidyBps)} subsidy / ${pct(t.holderBps)} holder`, `${pct(req.subsidyBps)} / ${pct(req.holderBps)}`, "the admin can change it with set_split"));
    }
    treasuryStep = d.length > 0 ? { kind: "differs", differences: d } : { kind: "done", detail: `admin ${t.admin}, split ${pct(t.subsidyBps)} subsidy / ${pct(t.holderBps)} holder, USDC ${t.usdcMint}` };
  } else {
    const block = programBlock("treasury", state.treasuryProgram, authority) ?? (state.mint.problem ? `the USDC mint ${state.mint.problem}` : undefined);
    treasuryStep = block
      ? { kind: "blocked", reason: block }
      : {
          kind: "todo",
          detail: `admin ${admin}, split ${pct(req.subsidyBps)} subsidy / ${pct(req.holderBps)} holder, USDC ${req.usdcMint}; makes the config and the two vaults`,
          instruction: treasury.initialize(programs.treasury, { authority, usdcMint: req.usdcMint, admin, subsidyBps: req.subsidyBps, holderBps: req.holderBps }),
          signers: [authority],
          rent: rentExempt(TREASURY_CONFIG_ACCOUNT_BYTES) + 2n * rentExempt(TOKEN_ACCOUNT_BYTES),
        };
  }
  push("treasury-initialize", treasuryStep);

  // ------------------------------------------------------------ 2. the breaks program
  const b = state.breaks.value;
  const treasuryReady = t !== undefined || treasuryStep.kind === "todo";
  let breaksStep: StepState;
  if (state.breaks.problem) {
    breaksStep = { kind: "blocked", reason: `the breaks program's config account ${state.breaks.problem}` };
  } else if (b) {
    const d: string[] = [];
    if (!same(b.admin, admin)) d.push(differ("admin", b.admin, admin, "there is no way to hand the admin over yet"));
    if (!same(b.keeper, req.keeper)) d.push(differ("keeper", b.keeper, req.keeper, "the admin can change it with set_keeper"));
    if (!same(b.buyer, req.buyer)) d.push(differ("buyer wallet", b.buyer, req.buyer, "the admin can change it with set_buyer"));
    if (!same(b.usdcMint, req.usdcMint)) d.push(differ("USDC mint", b.usdcMint, req.usdcMint, "set at initialization, cannot be changed: deploy again"));
    if (!same(b.randomnessProgram, req.vrfProgram)) d.push(differ("randomness program", b.randomnessProgram, req.vrfProgram, "the admin can change it with set_randomness"));
    if (b.randomnessTimeoutSecs !== req.randomnessTimeoutSecs) {
      d.push(differ("randomness timeout", `${b.randomnessTimeoutSecs} s`, `${req.randomnessTimeoutSecs} s`, "the admin can change it with set_randomness"));
    }
    if (b.minWindowSecs !== req.minWindowSecs || b.maxWindowSecs !== req.maxWindowSecs) {
      d.push(differ("sale window", `${b.minWindowSecs} to ${b.maxWindowSecs} s`, `${req.minWindowSecs} to ${req.maxWindowSecs} s`, "set at initialization, cannot be changed: deploy again"));
    }
    if (b.maxPaidSpots !== req.maxPaidSpots || b.maxFreeSpots !== req.maxFreeSpots) {
      d.push(differ("spot limits", `${b.maxPaidSpots} paid and ${b.maxFreeSpots} free`, `${req.maxPaidSpots} paid and ${req.maxFreeSpots} free`, "set at initialization, cannot be changed: deploy again"));
    }
    breaksStep =
      d.length > 0
        ? { kind: "differs", differences: d }
        : { kind: "done", detail: `admin ${b.admin}, keeper ${b.keeper}, buyer ${b.buyer}, up to ${b.maxPaidSpots} paid and ${b.maxFreeSpots} free spots, windows ${b.minWindowSecs} to ${b.maxWindowSecs} s` };
  } else {
    const block =
      programBlock("breaks", state.breaksProgram, authority) ??
      (state.mint.problem ? `the USDC mint ${state.mint.problem}` : undefined) ??
      (!treasuryReady ? "the treasury has to be initialized first, and it cannot be (see step 1)" : undefined) ??
      (t && !same(t.usdcMint, req.usdcMint) ? `the treasury uses the USDC mint ${t.usdcMint}, not ${req.usdcMint}: the breaks program takes its mint from the treasury (see step 1)` : undefined);
    breaksStep = block
      ? { kind: "blocked", reason: block }
      : {
          kind: "todo",
          detail: `admin ${admin}, keeper ${req.keeper}, buyer ${req.buyer}, up to ${req.maxPaidSpots} paid and ${req.maxFreeSpots} free spots, windows ${req.minWindowSecs} to ${req.maxWindowSecs} s, randomness ${req.vrfProgram} (timeout ${req.randomnessTimeoutSecs} s)`,
          instruction: breaks.initialize(programs, {
            authority,
            usdcMint: req.usdcMint,
            admin,
            keeper: req.keeper,
            buyer: req.buyer,
            minWindowSecs: req.minWindowSecs,
            maxWindowSecs: req.maxWindowSecs,
            maxPaidSpots: req.maxPaidSpots,
            maxFreeSpots: req.maxFreeSpots,
            randomnessProgram: req.vrfProgram,
            randomnessTimeoutSecs: req.randomnessTimeoutSecs,
          }),
          signers: [authority],
          rent: rentExempt(BREAKS_CONFIG_ACCOUNT_BYTES),
          ...(t === undefined ? { after: "treasury-initialize" as const } : {}),
        };
  }
  push("breaks-initialize", breaksStep);

  // ------------------------------------------------------------ 3. the controller
  let controllerStep: StepState;
  const unsent: StepId | undefined = b === undefined ? "breaks-initialize" : t === undefined ? "treasury-initialize" : undefined;
  if (t === undefined && treasuryStep.kind !== "todo") {
    controllerStep = { kind: "blocked", reason: "the treasury is not initialized (see step 1)" };
  } else if (b === undefined && breaksStep.kind !== "todo") {
    controllerStep = { kind: "blocked", reason: "the breaks program is not initialized (see step 2)" };
  } else if (t && same(t.controller, controller)) {
    controllerStep = { kind: "done", detail: `the controller is ${controller}, the breaks program's authority` };
  } else if (t && !same(t.controller, NO_CONTROLLER)) {
    controllerStep = {
      kind: "differs",
      differences: [`controller: on chain ${t.controller}, the breaks program's authority is ${controller} (this tool does not replace a controller that is set; the admin can with set_controller)`],
    };
  } else {
    // Whoever the treasury says is its admin has to sign; before it exists that is the admin asked for.
    const signerAdmin = t?.admin ?? admin;
    const instruction = treasury.setController(programs.treasury, { admin: signerAdmin, controller });
    const detail = `the treasury's admin ${signerAdmin} appoints ${controller} (the breaks program's authority) as controller`;
    controllerStep = held(signerAdmin)
      ? { kind: "todo", detail, instruction, signers: [...new Set([authority, signerAdmin])], rent: 0n, ...(unsent ? { after: unsent } : {}) }
      : { kind: "needs-admin", detail, instruction, admin: signerAdmin, ...(unsent ? { after: unsent } : {}) };
  }
  push("treasury-controller", controllerStep);

  // ------------------------------------------------------------ 4. the buyer's USDC account
  const account = associatedTokenAddress(req.buyer, req.usdcMint);
  let buyerStep: StepState;
  if (state.buyerUsdc.problem) buyerStep = { kind: "blocked", reason: `the buyer's USDC account ${account} ${state.buyerUsdc.problem}` };
  else if (state.buyerUsdc.exists) buyerStep = { kind: "done", detail: `${account} exists` };
  else if (state.mint.problem) buyerStep = { kind: "blocked", reason: `the USDC mint ${state.mint.problem}` };
  else {
    buyerStep = {
      kind: "todo",
      detail: `creates ${account} for ${req.buyer}`,
      instruction: createAssociatedTokenAccountIdempotent({ payer: authority, owner: req.buyer, mint: req.usdcMint }),
      signers: [authority],
      rent: rentExempt(TOKEN_ACCOUNT_BYTES),
    };
  }
  push("buyer-usdc", buyerStep);

  // ------------------------------------------------------------ what it costs
  const todo = steps.flatMap((s) => (s.state.kind === "todo" ? [s.state] : []));
  const fees = todo.reduce((sum, s) => sum + SIGNATURE_FEE * BigInt(s.signers.length), 0n);
  const needed = todo.length === 0 ? 0n : todo.reduce((sum, s) => sum + s.rent, 0n) + fees + rentExempt(0);
  if (state.authorityLamports < needed) {
    problems.push(
      `the upgrade authority ${authority} holds ${state.authorityLamports} lamports and this needs ${needed} (rent of the accounts, fees, and the ${rentExempt(0)} an account must keep): send it devnet SOL`,
    );
  }
  return { steps, problems, needed };
}

/** The step that can be sent now: the first `todo` whose earlier step is in place. */
export function nextToSend(plan: Plan): (Step & { state: Extract<StepState, { kind: "todo" }> }) | undefined {
  for (const step of plan.steps) {
    if (step.state.kind !== "todo") continue;
    const after = step.state.after;
    const waiting = after !== undefined && plan.steps.find((s) => s.id === after)?.state.kind !== "done";
    if (!waiting) return step as Step & { state: Extract<StepState, { kind: "todo" }> };
  }
  return undefined;
}
