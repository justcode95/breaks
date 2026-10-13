// Instruction builders and account decoder for the `treasury` program.
// Every byte and every account position is checked against programs/treasury/instruction-vectors.json,
// which the Rust tests generate from the program itself.

import { utf8 } from "../draw/bytes.js";
import { Writer, accountReader } from "./codec.js";
import {
  type Instruction,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  instructionDiscriminator,
  programDataAddress,
  readonly,
  signer,
  signerMut,
  writable,
} from "./instruction.js";
import { type Address, findProgramAddress } from "./pubkey.js";

export type Bucket = "Subsidy" | "Holder";
const BUCKET_INDEX: Record<Bucket, number> = { Subsidy: 0, Holder: 1 };

export interface TreasuryAddresses {
  config: Address;
  subsidyVault: Address;
  holderVault: Address;
}

export function treasuryAddresses(programId: Address): TreasuryAddresses {
  const pda = (seed: string) => findProgramAddress([utf8(seed)], programId).address;
  return {
    config: pda("config"),
    subsidyVault: pda("subsidy_vault"),
    holderVault: pda("holder_vault"),
  };
}

function build(programId: Address, name: string, args: Writer | null, accounts: Instruction["accounts"]): Instruction {
  const head = instructionDiscriminator(name);
  const tail = args ? args.finish() : new Uint8Array(0);
  const data = new Uint8Array(head.length + tail.length);
  data.set(head, 0);
  data.set(tail, head.length);
  return { programId, accounts, data };
}

/** Only the program's upgrade authority can call this, once. */
export function initialize(
  programId: Address,
  p: { authority: Address; usdcMint: Address; admin: Address; subsidyBps: number; holderBps: number },
): Instruction {
  const a = treasuryAddresses(programId);
  return build(programId, "initialize", new Writer().address(p.admin).u16(p.subsidyBps).u16(p.holderBps), [
    signerMut(p.authority),
    readonly(programId),
    readonly(programDataAddress(programId)),
    writable(a.config),
    readonly(p.usdcMint),
    writable(a.subsidyVault),
    writable(a.holderVault),
    readonly(TOKEN_PROGRAM),
    readonly(SYSTEM_PROGRAM),
  ]);
}

/** Anyone can pay USDC in; the program splits it between the two buckets. */
export function depositFees(
  programId: Address,
  p: { depositor: Address; depositorUsdc: Address; amount: bigint },
): Instruction {
  const a = treasuryAddresses(programId);
  return build(programId, "deposit_fees", new Writer().u64(p.amount), [
    signer(p.depositor),
    writable(p.depositorUsdc),
    readonly(a.config),
    writable(a.subsidyVault),
    writable(a.holderVault),
    readonly(TOKEN_PROGRAM),
  ]);
}

export function setSplit(
  programId: Address,
  p: { admin: Address; subsidyBps: number; holderBps: number },
): Instruction {
  const a = treasuryAddresses(programId);
  return build(programId, "set_split", new Writer().u16(p.subsidyBps).u16(p.holderBps), [
    signer(p.admin),
    writable(a.config),
  ]);
}

export function setController(programId: Address, p: { admin: Address; controller: Address }): Instruction {
  const a = treasuryAddresses(programId);
  return build(programId, "set_controller", new Writer().address(p.controller), [
    signer(p.admin),
    writable(a.config),
  ]);
}

function controllerCall(
  programId: Address,
  name: "lock_funds" | "unlock_funds",
  p: { controller: Address; subsidy: bigint; holder: bigint },
): Instruction {
  const a = treasuryAddresses(programId);
  return build(programId, name, new Writer().u64(p.subsidy).u64(p.holder), [
    signer(p.controller),
    writable(a.config),
    readonly(a.subsidyVault),
    readonly(a.holderVault),
  ]);
}

/** Only the controller (the `breaks` program's authority PDA) can call this, via CPI. Builders exist for tests and tooling. */
export const lockFunds = (programId: Address, p: { controller: Address; subsidy: bigint; holder: bigint }) =>
  controllerCall(programId, "lock_funds", p);

export const unlockFunds = (programId: Address, p: { controller: Address; subsidy: bigint; holder: bigint }) =>
  controllerCall(programId, "unlock_funds", p);

export function payFromLocked(
  programId: Address,
  p: { controller: Address; destination: Address; bucket: Bucket; amount: bigint },
): Instruction {
  const a = treasuryAddresses(programId);
  return build(programId, "pay_from_locked", new Writer().u8(BUCKET_INDEX[p.bucket]).u64(p.amount), [
    signer(p.controller),
    writable(a.config),
    writable(a.subsidyVault),
    writable(a.holderVault),
    writable(p.destination),
    readonly(TOKEN_PROGRAM),
  ]);
}

export interface TreasuryConfig {
  admin: Address;
  usdcMint: Address;
  controller: Address;
  subsidyBps: number;
  holderBps: number;
  lockedSubsidy: bigint;
  lockedHolder: bigint;
  bump: number;
}

/** Reads the `Config` account (raw account data, discriminator included). */
export function decodeTreasuryConfig(data: Uint8Array): TreasuryConfig {
  const r = accountReader(data, "Config");
  return {
    admin: r.address(),
    usdcMint: r.address(),
    controller: r.address(),
    subsidyBps: r.u16(),
    holderBps: r.u16(),
    lockedSubsidy: r.u64(),
    lockedHolder: r.u64(),
    bump: r.u8(),
  };
}
