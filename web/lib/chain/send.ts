// The parts of sending a transaction that do not depend on which instruction it is, shared by buying a spot and by refunding one:
// what the program's errors mean in words, asking the wallet to sign and send, and watching the network until it says what became
// of the transaction. A page never trusts the wallet's word that something was sent: it asks its own node about the signature.

import { SolanaSignAndSendTransaction, type SolanaSignAndSendTransactionFeature } from "@solana/wallet-standard-features";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { base58 } from "@scure/base";
import { CHAIN, displayName, endSentence, errorText } from "../wallet/wallets";
import { type RpcOptions, rpc } from "./rpc";

/** What one signature costs on Solana. Each flow here has one. */
export const SIGNATURE_FEE_LAMPORTS = 5000n;

/** The names of the program's errors, in the order of the Rust enum: the number of an error is 6000 plus its place here. */
export const BREAKS_ERRORS = [
  "Unauthorized",
  "InvalidProgramData",
  "Paused",
  "InvalidLimits",
  "InvalidSpotCounts",
  "InvalidPrice",
  "SpotPriceAboveAveragePack",
  "InvalidWindow",
  "WrongStatus",
  "NotInSaleWindow",
  "TooEarlyToClose",
  "SoldOut",
  "WrongSpotIndex",
  "MathOverflow",
  "InvalidEligibility",
  "EmptyPool",
  "PoolSizeMismatch",
  "AlreadyRefunded",
  "InvalidRandomnessRecord",
  "RandomnessNotFulfilled",
  "AlreadyFulfilled",
  "RequestNotTimedOut",
  "TooManyAttempts",
  "InvalidRandomnessConfig",
  "WrongClaimIndex",
  "InvalidProof",
  "NotTheDrawnWinner",
  "WinnerAlreadyDrawn",
  "InvalidPackList",
  "PacksWorthLessThanSpots",
] as const;

type ErrorName = (typeof BREAKS_ERRORS)[number];

const ANCHOR_ERROR_OFFSET = 6000;

/** Which flow an error came from: the same program error means different things to a buyer and to someone being refunded. */
export type Flow = "buy" | "refund";

interface FlowWords {
  /** What did not happen, in "Nothing was ...". */
  nothing: string;
  /** What the wallet runs out of SOL for. */
  feeFor: string;
  /** What the program said, in words, for the errors this flow can meet. The others are named. */
  messages: Partial<Record<ErrorName, string>>;
}

const WORDS: Record<Flow, FlowWords> = {
  buy: {
    nothing: "bought",
    feeFor: "the fee and the new account",
    messages: {
      Paused: "Sales are paused by the program's admin.",
      WrongStatus: "The sale of this break is over.",
      NotInSaleWindow: "The sale is not open (it has not started, or it has ended).",
      SoldOut: "All paid spots are taken.",
      WrongSpotIndex: "Someone else took that spot first. Read the break again and try once more.",
    },
  },
  refund: {
    nothing: "refunded",
    feeFor: "the network fee",
    messages: {
      WrongStatus: "This break was not cancelled, so its spots are not refunded.",
      AlreadyRefunded: "This spot was already refunded.",
    },
  },
};

const TAKEN = "This spot was probably just taken by someone else. Read the break again and try once more.";
const TOO_POOR = "The wallet probably has too little USDC or SOL for this purchase.";

/**
 * A transaction error from the network, as words. A custom number from the breaks program is its error. For a purchase, the two
 * small numbers that the token and system programs use when it cannot be paid for, or a spot is taken, are said as what they most
 * likely mean, since the error alone does not say which program raised it; a refund has no such guess and names the number.
 */
export function describeTransactionError(err: unknown, flow: Flow = "buy"): string {
  const words = WORDS[flow];
  const noFunds = `The wallet does not have enough SOL for ${words.feeFor}.`;
  if (typeof err === "string") {
    if (err === "BlockhashNotFound") return `The transaction was too old (its blockhash expired). Nothing was ${words.nothing}; try again.`;
    if (err === "InsufficientFundsForFee" || err === "InsufficientFundsForRent") return noFunds;
    if (err === "AccountNotFound") return "The wallet has no SOL, so it cannot pay the network fee.";
    return `The network refused it (${err}).`;
  }
  if (typeof err === "object" && err !== null) {
    const instruction = (err as { InstructionError?: unknown }).InstructionError;
    if (Array.isArray(instruction)) {
      const detail = instruction[1];
      if (typeof detail === "object" && detail !== null && typeof (detail as { Custom?: unknown }).Custom === "number") {
        const code = (detail as { Custom: number }).Custom;
        const name = BREAKS_ERRORS[code - ANCHOR_ERROR_OFFSET];
        if (code >= ANCHOR_ERROR_OFFSET && name) return words.messages[name] ?? `The program refused it (${name}).`;
        if (flow === "buy" && code === 0) return TAKEN;
        if (flow === "buy" && code === 1) return TOO_POOR;
      }
      if (flow === "buy" && detail === "InsufficientFunds") return TOO_POOR;
    }
    if ("InsufficientFundsForRent" in err) return noFunds;
  }
  const text = JSON.stringify(err) ?? String(err);
  return `The network refused it (${text.length > 200 ? `${text.slice(0, 199)}…` : text}).`;
}

export function integer(value: unknown, what: string): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`the node did not give ${what}`);
  return BigInt(value);
}

/** What the node asks to keep an account of `bytes` bytes alive. */
export const rentExempt = (nodeOpts: RpcOptions, bytes: number, what: string): Promise<bigint> =>
  rpc<unknown>(nodeOpts, "getMinimumBalanceForRentExemption", [bytes]).then((r) => integer(r, what));

/** A wallet's SOL, in lamports. */
export const solBalance = (nodeOpts: RpcOptions, address: string): Promise<bigint> =>
  rpc<{ value?: unknown }>(nodeOpts, "getBalance", [address, { commitment: "confirmed" }]).then((r) => integer(r?.value, "the wallet's SOL balance"));

/** A recent blockhash and the last block it is good for. */
export async function latestBlockhash(nodeOpts: RpcOptions): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const latest = await rpc<{ value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } }>(nodeOpts, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const blockhash = latest?.value?.blockhash;
  const lastValidBlockHeight = latest?.value?.lastValidBlockHeight;
  if (typeof blockhash !== "string" || typeof lastValidBlockHeight !== "number") throw new Error("the node did not give a recent blockhash");
  return { blockhash, lastValidBlockHeight };
}

export type Sent = { ok: true; signature: string } | { ok: false; reason: string };

/**
 * Asks the wallet to sign and send the transaction, on devnet. A wallet that cannot, refuses, or gives nothing back is `declined`
 * with the advice to look at the wallet's history first: a wallet can send a transaction and then fail to say so.
 */
export async function signAndSend(wallet: Wallet, account: WalletAccount, transaction: Uint8Array): Promise<Sent> {
  const feature = (wallet.features as Partial<SolanaSignAndSendTransactionFeature>)[SolanaSignAndSendTransaction];
  if (!feature) return { ok: false, reason: `${displayName(wallet)} cannot send Solana transactions.` };
  try {
    const [out] = await feature.signAndSendTransaction({ account, transaction, chain: CHAIN });
    if (!out || out.signature.length !== 64) throw new Error("the wallet did not give back a transaction signature");
    return { ok: true, signature: base58.encode(out.signature) };
  } catch (err) {
    return { ok: false, reason: `${displayName(wallet)} did not send the transaction: ${endSentence(errorText(err))} If you approved it, check your wallet's history before trying again.` };
  }
}

export interface Timing {
  /** Milliseconds, for the time allowed for a confirmation. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the network to confirm, once the wallet has sent it. */
  confirmTimeoutMs?: number;
  pollMs?: number;
}

export type Watched = { kind: "confirmed" } | { kind: "failed"; reason: string } | { kind: "unconfirmed"; reason: string };

interface SignatureStatus {
  err: unknown;
  confirmationStatus?: string | null;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits for the network to say what became of the transaction. A node that fails to answer is asked again; only the time running out stops it. */
export async function watchTransaction(nodeOpts: RpcOptions, signature: string, lastValidBlockHeight: number, flow: Flow, timing: Timing = {}): Promise<Watched> {
  const clock = timing.clock ?? Date.now;
  const sleep = timing.sleep ?? wait;
  const timeout = timing.confirmTimeoutMs ?? 60_000;
  const pollMs = timing.pollMs ?? 1500;
  const started = clock();
  let lastError = "";
  for (let poll = 0; ; poll++) {
    try {
      const res = await rpc<{ value?: (SignatureStatus | null)[] }>(nodeOpts, "getSignatureStatuses", [[signature], { searchTransactionHistory: false }]);
      const status = res?.value?.[0] ?? null;
      if (status) {
        if (status.err !== null && status.err !== undefined) return { kind: "failed", reason: describeTransactionError(status.err, flow) };
        if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") return { kind: "confirmed" };
      } else if (poll % 4 === 3) {
        // Not heard of: once the chain is past the blockhash's last valid height, it can no longer land.
        const height = await rpc<unknown>(nodeOpts, "getBlockHeight", [{ commitment: "confirmed" }]);
        if (typeof height === "number" && height > lastValidBlockHeight) {
          return { kind: "failed", reason: `The transaction expired before it landed, so nothing was ${WORDS[flow].nothing}. You can try again.` };
        }
      }
    } catch (err) {
      lastError = errorText(err);
    }
    if (clock() - started >= timeout) {
      const why = lastError ? ` The last attempt to ask the network failed: ${endSentence(lastError)}` : "";
      return { kind: "unconfirmed", reason: `The network has not confirmed the transaction yet. It may still land, so check your wallet's history or the explorer before trying again.${why}` };
    }
    await sleep(pollMs);
  }
}
