// Runs setup: read the chain, plan, and (with --send) do the next missing step, one transaction at a time, reading the chain again
// before each one so that a step that already landed, or was done by somebody else, is never sent twice. Reports every step.
//
// Exit codes: 0 everything is in place (or, without --send, the plan is clean), 1 something is wrong or a send did not land,
// 2 a bad command line, 3 only the admin can do what is left.

import { base64 } from "@scure/base";
import type { SendResult } from "../pipeline/chain.js";
import type { Instruction } from "../solana/instruction.js";
import type { Signer } from "../solana/keypair.js";
import type { SetupRequest } from "./args.js";
import { type Plan, type ResolvedRequest, type Step, STEP_ORDER, nextToSend, planSetup } from "./plan.js";
import { type AccountSource, readState } from "./read.js";

export interface SetupChain extends AccountSource {
  sendAndConfirm(instructions: Instruction[], opts?: { signers?: readonly Signer[] }): Promise<SendResult>;
}

export interface SetupKeys {
  authority: Signer;
  /** The admin's key, when this run has it. */
  admin?: Signer;
}

export interface SetupResult {
  code: 0 | 1 | 3;
  out: string;
  sent: { step: Step["id"]; signature: string }[];
}

const MARK = { done: "[done]", todo: "[todo]", sent: "[sent]", fail: "[FAIL]", wait: "[wait]", diff: "[diff]", stop: "[stop]" } as const;
const INDENT = "       ";
const LAMPORTS_PER_SOL = 1_000_000_000n;

export const sol = (lamports: bigint): string => {
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} SOL`;
};

/** What an admin needs to send an instruction by other means (a multisig proposal, say): the program, the accounts and the data. */
export function describeInstruction(ix: Instruction): string[] {
  return [
    `program ${ix.programId}`,
    ...ix.accounts.map((a, i) => `account ${i + 1}: ${a.pubkey}${a.isSigner ? " (signer)" : ""}${a.isWritable ? " (writable)" : ""}`),
    `data (base64): ${base64.encode(ix.data)}`,
    `data (hex): ${[...ix.data].map((n) => n.toString(16).padStart(2, "0")).join("")}`,
  ];
}

interface Outcome {
  /** A step this run sent, or tried to. */
  step: Step["id"];
  result: SendResult;
}

function renderStep(index: number, step: Step, outcome: Outcome | undefined, send: boolean): string[] {
  const head = `${index + 1}. ${step.title}`;
  const s = step.state;
  const lines: string[] = [];
  const after = (id: Step["id"] | undefined) => (id ? ` (after step ${STEP_ORDER.indexOf(id) + 1})` : "");

  if (outcome && outcome.result.outcome !== "confirmed") {
    const failed = outcome.result.outcome === "failed";
    lines.push(`  ${failed ? MARK.fail : MARK.stop} ${head}`);
    lines.push(`${INDENT}${failed ? "the chain refused it, nothing changed" : "the result is not known: look at the chain before running this again"}: ${outcome.result.reason}`);
    if (outcome.result.signature) lines.push(`${INDENT}transaction ${outcome.result.signature}`);
    return lines;
  }
  const sentNow = outcome?.result.outcome === "confirmed" ? outcome : undefined;
  switch (s.kind) {
    case "done":
      lines.push(`  ${sentNow ? MARK.sent : MARK.done} ${head}`);
      lines.push(`${INDENT}${s.detail}`);
      if (sentNow?.result.signature) lines.push(`${INDENT}transaction ${sentNow.result.signature}`);
      break;
    case "todo":
      lines.push(`  ${MARK.todo} ${head}${after(s.after)}`);
      lines.push(`${INDENT}${send ? "to send" : "would send"}: ${s.detail}`);
      break;
    case "needs-admin":
      lines.push(`  ${MARK.wait} ${head}${after(s.after)}`);
      lines.push(`${INDENT}only the admin ${s.admin} can send this, and this run does not hold its key: ${s.detail}`);
      lines.push(`${INDENT}send it from the admin (a multisig can propose it) with:`);
      for (const l of describeInstruction(s.instruction)) lines.push(`${INDENT}  ${l}`);
      break;
    case "differs":
      lines.push(`  ${MARK.diff} ${head}`);
      lines.push(`${INDENT}it is on chain, but not as asked (nothing was changed):`);
      for (const d of s.differences) lines.push(`${INDENT}- ${d}`);
      break;
    case "blocked":
      lines.push(`  ${MARK.stop} ${head}`);
      lines.push(`${INDENT}cannot be done: ${s.reason}`);
      break;
  }
  return lines;
}

export async function runSetup(
  req: SetupRequest,
  deps: { chain: SetupChain; keys: SetupKeys; hide?: (text: string) => string; warnings?: string[] },
): Promise<SetupResult> {
  const hide = deps.hide ?? ((t: string) => t);
  const { authority, admin: adminKey } = deps.keys;
  const resolved: ResolvedRequest = {
    ...req,
    authority: authority.address,
    admin: req.admin ?? adminKey?.address ?? authority.address,
    held: [...new Set([authority.address, ...(adminKey ? [adminKey.address] : [])])],
  };

  const out: string[] = [req.send ? "Devnet setup. Sending the steps that are missing." : "Devnet setup. Dry run: nothing is sent (add --send to do the steps marked todo).", ""];
  const early: string[] = [];
  if (req.admin && adminKey && req.admin !== adminKey.address) early.push(`--admin is ${req.admin} but --admin-keypair is the key of ${adminKey.address}`);

  const outcomes: Outcome[] = [];
  let plan = planSetup(resolved, await readState(deps.chain, resolved));
  const problems = (p: Plan) => [...early, ...p.problems];
  // Something that has to be settled by a person (a value that differs, a step that cannot be done from here, a problem with the
  // keys or the SOL) stops everything: nothing is sent while the picture is not clean.
  const clean = (p: Plan) => problems(p).length === 0 && !p.steps.some((s) => s.state.kind === "differs" || s.state.kind === "blocked");

  if (req.send) {
    // Read again after every step: what landed is then seen, and what somebody else did in the meantime is not repeated.
    for (let i = 0; i < STEP_ORDER.length; i++) {
      if (!clean(plan)) break;
      const next = nextToSend(plan);
      if (!next) break;
      const signers = next.state.signers.map((a) => (a === authority.address ? authority : adminKey && a === adminKey.address ? adminKey : undefined));
      if (signers.some((s) => s === undefined)) break; // planSetup only asks for keys this run holds
      const result = await deps.chain.sendAndConfirm([next.state.instruction], { signers: signers as Signer[] });
      outcomes.push({ step: next.id, result });
      if (result.outcome !== "confirmed") break;
      plan = planSetup(resolved, await readState(deps.chain, resolved));
    }
  }

  out.push(`Authority (pays for everything): ${resolved.authority}`);
  out.push(`Admin: ${resolved.admin}${resolved.held.includes(resolved.admin) ? " (this run holds its key)" : " (this run does not hold its key)"}`);
  out.push(`Keeper: ${req.keeper}`);
  out.push(`Buyer wallet: ${req.buyer}`);
  out.push(`USDC mint: ${req.usdcMint}`);
  out.push(`Programs: breaks ${req.programs.breaks}, treasury ${req.programs.treasury}`);
  for (const w of deps.warnings ?? []) out.push(`Warning: ${w}`);
  out.push("");

  plan.steps.forEach((step, i) => {
    out.push(...renderStep(i, step, outcomes.find((o) => o.step === step.id), req.send));
  });

  const all = problems(plan);
  if (all.length > 0) {
    out.push("");
    for (const p of all) out.push(`Problem: ${p}`);
  }

  const failed = outcomes.some((o) => o.result.outcome !== "confirmed");
  const blocked = plan.steps.some((s) => s.state.kind === "differs" || s.state.kind === "blocked");
  const waitingAdmin = plan.steps.some((s) => s.state.kind === "needs-admin");
  const todo = plan.steps.some((s) => s.state.kind === "todo");
  const complete = plan.steps.every((s) => s.state.kind === "done");

  out.push("");
  let code: SetupResult["code"];
  if (failed || blocked || all.length > 0) {
    code = 1;
    out.push(failed ? "NOT DONE. A step did not land: see above." : "NOT DONE. Something stands in the way: see above.");
  } else if (complete) {
    code = 0;
    out.push(outcomes.length > 0 ? "DONE. Everything is in place. Next: run `pnpm --filter keeper check-setup`." : "Nothing to do: everything is already in place. Next: run `pnpm --filter keeper check-setup`.");
  } else if (waitingAdmin && !todo) {
    code = 3;
    out.push("WAITING FOR THE ADMIN. Everything this run can do is done; the step marked wait needs the admin to send it.");
  } else if (!req.send) {
    code = 0;
    out.push("Dry run: nothing was sent. If this is what you want, run it again with --send.");
  } else {
    // --send was given and something is left that could be sent: it should not happen (a step that landed is read back as done).
    code = 1;
    out.push("NOT DONE. A step that was sent is not on chain yet: wait a few seconds and run this again.");
  }
  return { code, out: hide(out.join("\n")), sent: outcomes.flatMap((o) => (o.result.outcome === "confirmed" && o.result.signature ? [{ step: o.step, signature: o.result.signature }] : [])) };
}

