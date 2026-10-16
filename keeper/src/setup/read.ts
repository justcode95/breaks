// Reads what setup needs from the chain: the two programs and who may upgrade them, the USDC mint, the two configuration accounts
// and the buyer's USDC account. Reading is all it does. An account that is there but is not what it should be is reported as a
// problem in words, not guessed at.

import { UPGRADEABLE_LOADER, TOKEN_PROGRAM, SYSTEM_PROGRAM, programDataAddress } from "../solana/instruction.js";
import { PROGRAM_DATA_METADATA_BYTES, decodeProgramAccount, decodeProgramData } from "../solana/loader.js";
import { type Address, associatedTokenAddress } from "../solana/pubkey.js";
import { decodeBreaksConfig, configAddress, type BreaksConfigAccount } from "../solana/breaks.js";
import { decodeMint, decodeTokenAccount } from "../solana/token.js";
import { type TreasuryConfig, decodeTreasuryConfig, treasuryAddresses } from "../solana/treasury.js";
import type { ChainState, ProgramState, ResolvedRequest, Slot } from "./plan.js";

export interface AccountView {
  data: Uint8Array;
  owner: Address;
  lamports: bigint;
  executable: boolean;
}

/** What setup reads through: the chain client of the keeper (`RpcChainClient`) does this. */
export interface AccountSource {
  getAccount(address: Address, opts?: { dataSlice?: { offset: number; length: number } }): Promise<AccountView | undefined>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function program(chain: AccountSource, id: Address): Promise<ProgramState> {
  const account = await chain.getAccount(id);
  if (!account) return { problem: "does not exist on this network: is it deployed, and is the program id right?" };
  if (account.owner !== UPGRADEABLE_LOADER || !account.executable) return { problem: "is not an upgradeable program (it is not an executable account of the upgradeable loader)" };
  let programData: Address;
  try {
    programData = decodeProgramAccount(account.data).programData;
  } catch (err) {
    return { problem: `could not be read: ${message(err)}` };
  }
  if (programData !== programDataAddress(id)) return { problem: "points at a program-data account that is not its own" };
  // Only the first bytes: the rest of the program-data account is the program's code.
  const data = await chain.getAccount(programData, { dataSlice: { offset: 0, length: PROGRAM_DATA_METADATA_BYTES } });
  if (!data) return { problem: "has no program-data account" };
  try {
    const meta = decodeProgramData(data.data);
    return { upgradeAuthority: meta.upgradeAuthority ?? null };
  } catch (err) {
    return { problem: `could not be read: ${message(err)}` };
  }
}

async function mint(chain: AccountSource, address: Address): Promise<{ problem?: string }> {
  const account = await chain.getAccount(address);
  if (!account) return { problem: `${address} does not exist on this network` };
  if (account.owner !== TOKEN_PROGRAM) return { problem: `${address} is not a mint of the classic token program (it is owned by ${account.owner})` };
  try {
    const m = decodeMint(account.data);
    if (!m.initialized) return { problem: `${address} is not an initialized mint` };
    if (m.decimals !== 6) return { problem: `${address} has ${m.decimals} decimals; USDC has 6, and the programs count in USDC's base units` };
  } catch (err) {
    return { problem: `${address} could not be read: ${message(err)}` };
  }
  return {};
}

async function config<T>(chain: AccountSource, address: Address, owner: Address, decode: (data: Uint8Array) => T): Promise<Slot<T>> {
  const account = await chain.getAccount(address);
  if (!account) return {};
  if (account.owner !== owner) return { problem: `${address} is owned by ${account.owner}, not by the program that should own it` };
  try {
    return { value: decode(account.data) };
  } catch (err) {
    return { problem: `${address} could not be read: ${message(err)}` };
  }
}

async function buyerUsdc(chain: AccountSource, req: ResolvedRequest): Promise<ChainState["buyerUsdc"]> {
  const address = associatedTokenAddress(req.buyer, req.usdcMint);
  const account = await chain.getAccount(address);
  // An address that holds only SOL is not a token account yet (the creation instruction takes it over).
  if (!account || account.owner === SYSTEM_PROGRAM) return { exists: false };
  if (account.owner !== TOKEN_PROGRAM) return { exists: true, problem: `is owned by ${account.owner}, not by the token program` };
  try {
    const t = decodeTokenAccount(account.data);
    if (t.mint !== req.usdcMint || t.owner !== req.buyer) return { exists: true, problem: "belongs to another mint or owner than its address says" };
  } catch (err) {
    return { exists: true, problem: `could not be read: ${message(err)}` };
  }
  return { exists: true };
}

export async function readState(chain: AccountSource, req: ResolvedRequest): Promise<ChainState> {
  const [breaksProgram, treasuryProgram, usdc, treasury, breaksConfig, buyer, authority] = await Promise.all([
    program(chain, req.programs.breaks),
    program(chain, req.programs.treasury),
    mint(chain, req.usdcMint),
    config<TreasuryConfig>(chain, treasuryAddresses(req.programs.treasury).config, req.programs.treasury, decodeTreasuryConfig),
    config<BreaksConfigAccount>(chain, configAddress(req.programs), req.programs.breaks, decodeBreaksConfig),
    buyerUsdc(chain, req),
    chain.getAccount(req.authority),
  ]);
  return {
    breaksProgram,
    treasuryProgram,
    mint: usdc,
    treasury,
    breaks: breaksConfig,
    buyerUsdc: buyer,
    authorityLamports: authority?.lamports ?? 0n,
  };
}
