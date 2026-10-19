// Where a break's randomness came from, checked in the browser from the chain at `finalized`: the seed the program gave ORAO
// (the request id), which commits to the break, the attempt, the eligibility root and the pool hash, so it could not be known
// before both were fixed; ORAO's request account for that seed, at the address the VRF program derives for it; ORAO's 64-byte
// answer in it; and the draw seed, which must be SHA-256 of "breaks:seed:v1" and that answer.
//
// What stays ORAO's word is the answer itself: a fulfilled request keeps only the combined 64 bytes, not each oracle's
// signature, so the page cannot check them against ORAO's keys. The program accepts what ORAO's own program wrote.
//
// This is the web package's own code (pinned to the Rust program's vectors and the real ORAO crate's bytes), not the keeper's.

import { equalBytes, hashv, toHex, utf8 } from "../draw/bytes";
import { seedFromRandomness } from "../draw/draw";
import { type BreakAccount, decodeConfig } from "./accounts";
import { type Address, addressToBytes, breakAddress, configAddress, findProgramAddress } from "./address";
import { getAccounts } from "./rpc";

/** The most times a break may ask for randomness (`MAX_ATTEMPTS` in the program). */
export const MAX_RANDOMNESS_ATTEMPTS = 5;

/** `sha256("breaks:randomness:v1" ‖ break ‖ attempt ‖ eligibility root ‖ pool hash)`: the seed the program gives ORAO. */
export function requestId(breakKey: Address, attempt: number, eligibilityRoot: Uint8Array, poolHash: Uint8Array): Uint8Array {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 255) throw new RangeError("the attempt is a byte");
  return hashv(utf8("breaks:randomness:v1"), addressToBytes(breakKey), Uint8Array.of(attempt), eligibilityRoot, poolHash);
}

/** Where the VRF program keeps the request for `seed`. */
export const requestAddress = (vrfProgram: Address, seed: Uint8Array): Address => findProgramAddress([utf8("orao-vrf-randomness-request"), seed], vrfProgram);

/** The account name ORAO's request accounts start with (Anchor's `RandomnessV2`). */
const REQUEST_DISCRIMINATOR = Uint8Array.of(139, 239, 184, 215, 227, 86, 191, 226);
// The layout the program reads (programs/breaks/src/randomness.rs): the name (8), the state (1), the client (32), the seed (32),
// then a pending request's response list or a fulfilled request's 64 bytes.
const TAG_OFFSET = 8;
const SEED_OFFSET = 41;
const RANDOMNESS_OFFSET = SEED_OFFSET + 32;
const PENDING_MIN_LEN = RANDOMNESS_OFFSET + 4;
const FULFILLED_MIN_LEN = RANDOMNESS_OFFSET + 64;

export type RequestState = { state: "pending" } | { state: "fulfilled"; randomness: Uint8Array };

/** Reads an ORAO request account the way the program does. Throws, saying why, unless it is a request for `seed`. */
export function parseRequest(data: Uint8Array, seed: Uint8Array): RequestState {
  if (data.length < PENDING_MIN_LEN || !equalBytes(data.subarray(0, 8), REQUEST_DISCRIMINATOR)) throw new Error("it is not an ORAO randomness request");
  if (!equalBytes(data.subarray(SEED_OFFSET, SEED_OFFSET + 32), seed)) throw new Error("it is a request for another seed");
  switch (data[TAG_OFFSET]) {
    case 0:
      return { state: "pending" };
    case 1: {
      if (data.length < FULFILLED_MIN_LEN) throw new Error("its answer is cut short");
      const randomness = data.slice(RANDOMNESS_OFFSET, FULFILLED_MIN_LEN);
      // A signature is never all zeros; the program refuses a blank answer too.
      if (randomness.every((x) => x === 0)) throw new Error("its answer is blank");
      return { state: "fulfilled", randomness };
    }
    default:
      throw new Error(`it is in a state the program does not know (${data[TAG_OFFSET]})`);
  }
}

export interface RandomnessCheck {
  /** The request id worked out here, which must be the one on the break. */
  requestId: Uint8Array;
  vrfProgram: Address;
  requestAddress: Address;
  request: RequestState;
  /** Everything that does not agree, in words; empty when it all does. */
  problems: string[];
}

export type RandomnessView =
  /** Randomness is not asked for before the pool is committed. */
  | { kind: "not-yet" }
  | { kind: "unavailable"; message: string }
  | { kind: "checked"; check: RandomnessCheck };

const STAGES = new Set(["RandomnessRequested", "Settled", "Drawn"]);
const ZERO = (b: Uint8Array) => b.every((x) => x === 0);

/** The checks, from the break, the program's VRF program and the request account as read. */
export function checkRandomness(b: BreakAccount, breaksProgram: Address, vrfProgram: Address, request: { owner: Address; data: Uint8Array } | null): RandomnessCheck {
  const problems: string[] = [];
  const id = requestId(breakAddress(breaksProgram, b.id), b.randomnessAttempt, b.eligibilityRoot, b.poolHash);
  if (b.randomnessAttempt < 1 || b.randomnessAttempt > MAX_RANDOMNESS_ATTEMPTS) problems.push(`the break says it asked ${b.randomnessAttempt} times, which the program never allows`);
  if (!equalBytes(id, b.randomnessRequestId)) {
    problems.push(`the break's request id is ${toHex(b.randomnessRequestId)}, but the break, its attempt, the eligibility root and the pool hash give ${toHex(id)}`);
  }
  const address = requestAddress(vrfProgram, id);
  let state: RequestState = { state: "pending" };
  if (!request) problems.push(`there is no request account at ${address}`);
  else if (request.owner !== vrfProgram) problems.push(`the request account is not owned by the randomness program ${vrfProgram}`);
  else {
    try {
      state = parseRequest(request.data, id);
    } catch (err) {
      problems.push(`the request account cannot be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const seeded = b.status === "Settled" || b.status === "Drawn";
  if (seeded) {
    if (state.state !== "fulfilled") {
      if (problems.length === 0) problems.push("the break has a seed, but ORAO has not answered its request");
    } else if (!equalBytes(seedFromRandomness(state.randomness), b.seed)) {
      problems.push(`the draw seed is ${toHex(b.seed)}, but SHA-256 of "breaks:seed:v1" and ORAO's answer is ${toHex(seedFromRandomness(state.randomness))}`);
    }
  } else if (!ZERO(b.seed)) problems.push("the break has a seed before its randomness is settled");
  return { requestId: id, vrfProgram, requestAddress: address, request: state, problems };
}

/**
 * Reads the program's config (for the randomness program) and the request account, both at `finalized`, and checks them.
 * Never throws. The request is looked up under the randomness program the config names now: if the admin has switched it since
 * the request was made, the request is not found there and the page says so.
 */
export async function loadRandomness(opts: { rpcUrl: string; breaksProgram: Address; break: BreakAccount; fetch?: typeof fetch }): Promise<RandomnessView> {
  const b = opts.break;
  if (!STAGES.has(b.status)) return { kind: "not-yet" };
  const net = { url: opts.rpcUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) };
  try {
    const [config] = await getAccounts({ ...net, addresses: [configAddress(opts.breaksProgram)] });
    if (!config) return { kind: "unavailable", message: "the program's config account, which names the randomness program, is missing" };
    if (config.owner !== opts.breaksProgram) return { kind: "unavailable", message: "the program's config account is not owned by the breaks program" };
    const vrf = decodeConfig(config.data).randomnessProgram;
    const id = requestId(breakAddress(opts.breaksProgram, b.id), b.randomnessAttempt, b.eligibilityRoot, b.poolHash);
    const [request] = await getAccounts({ ...net, addresses: [requestAddress(vrf, id)] });
    return { kind: "checked", check: checkRandomness(b, opts.breaksProgram, vrf, request ? { owner: request.owner, data: request.data } : null) };
  } catch (err) {
    return { kind: "unavailable", message: err instanceof Error ? err.message : String(err) };
  }
}
