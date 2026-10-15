// Buying a paid spot from the site, from the first check to the confirmation. Every check that can be made without the wallet
// is made first, and nothing is put in front of the wallet until they pass; after the wallet has the transaction, the outcome is
// said as exactly as it is known: bought, refused by the network, expired, or not heard of yet. Nothing here is specific to a
// page: the page passes in the wallet and gets a result back. Devnet only: the node is asked which network it is, first.

import { SolanaSignAndSendTransaction, type SolanaSignAndSendTransactionFeature } from "@solana/wallet-standard-features";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { base58 } from "@scure/base";
import { CHAIN, displayName, endSentence, errorText } from "../wallet/wallets";
import { type BreakAccount, type ConfigAccount, SPOT_ACCOUNT_BYTES, decodeBreak, decodeConfig } from "./accounts";
import { type Address, breakAddress, configAddress } from "./address";
import { loadUsdcBalance } from "./balance";
import { buySpotInstruction, checkAfford, checkSale } from "./buy";
import { checkDevnet } from "./cluster";
import { LoadError } from "./load";
import { type RpcOptions, RpcFailure, getAccounts, rpc } from "./rpc";
import { buildTransaction } from "./transaction";
import { sol } from "./view";

export { SPOT_ACCOUNT_BYTES };
/** What one signature costs on Solana. A purchase has one. */
export const SIGNATURE_FEE_LAMPORTS = 5000n;

/** The names of the program's errors, in the order of the Rust enum: the number of an error is 6000 plus its place here. */
export const BREAKS_ERRORS = [
  "Unauthorized",
  "InvalidProgramData",
  "Paused",
  "InvalidLimits",
  "InvalidSpotCounts",
  "InvalidPrice",
  "SpotPriceAboveMaxPackPrice",
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
] as const;

const ANCHOR_ERROR_OFFSET = 6000;
const TAKEN = "This spot was probably just taken by someone else. Read the break again and try once more.";
const TOO_POOR = "The wallet probably has too little USDC or SOL for this purchase.";

/** What the program said, in words, for the errors a purchase can meet. The others are named. */
const BREAKS_MESSAGES: Partial<Record<(typeof BREAKS_ERRORS)[number], string>> = {
  Paused: "Sales are paused by the program's admin.",
  WrongStatus: "The sale of this break is over.",
  NotInSaleWindow: "The sale is not open (it has not started, or it has ended).",
  SoldOut: "All paid spots are taken.",
  WrongSpotIndex: "Someone else took that spot first. Read the break again and try once more.",
};

/**
 * A transaction error from the network, as words. A custom number from the breaks program is its error; the two small numbers
 * that the token and system programs use when a purchase cannot be paid for, or a spot is taken, are said as what they most
 * likely mean, since the error alone does not say which program raised it.
 */
export function describeTransactionError(err: unknown): string {
  if (typeof err === "string") {
    if (err === "BlockhashNotFound") return "The transaction was too old (its blockhash expired). Nothing was bought; try again.";
    if (err === "InsufficientFundsForFee" || err === "InsufficientFundsForRent") return "The wallet does not have enough SOL for the fee and the new account.";
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
        if (code >= ANCHOR_ERROR_OFFSET && name) return BREAKS_MESSAGES[name] ?? `The program refused it (${name}).`;
        if (code === 0) return TAKEN;
        if (code === 1) return TOO_POOR;
      }
      if (detail === "InsufficientFunds") return TOO_POOR;
    }
    if ("InsufficientFundsForRent" in err) return "The wallet does not have enough SOL for the fee and the new account.";
  }
  const text = JSON.stringify(err) ?? String(err);
  return `The network refused it (${text.length > 200 ? `${text.slice(0, 199)}…` : text}).`;
}

export type PurchaseStep = "checking" | "waiting-for-wallet" | "confirming";

export type PurchaseResult =
  /** The network confirmed it: the spot is the buyer's. */
  | { kind: "bought"; signature: string; index: number; price: bigint }
  /** A check failed before the wallet was asked: nothing was sent. */
  | { kind: "refused"; reason: string }
  /** The wallet did not send it, or said no. (If it did send it, the wallet's history shows it.) */
  | { kind: "declined"; reason: string }
  /** It reached the network and was refused, or it expired before it landed: nothing was bought. */
  | { kind: "failed"; signature: string; reason: string }
  /** The wallet sent it but the network has not said anything yet: it may still land. */
  | { kind: "unconfirmed"; signature: string; reason: string };

export interface PurchaseOptions {
  rpcUrl: string;
  /** The breaks program. */
  program: Address;
  /** The number people see for the break: the on-chain id + 1. */
  breakNumber: number;
  wallet: Wallet;
  account: WalletAccount;
  fetch?: typeof fetch;
  /** Seconds since 1970, for the sale window. */
  now?: () => number;
  /** Milliseconds, for the time allowed for a confirmation. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the network to confirm, once the wallet has sent it. */
  confirmTimeoutMs?: number;
  pollMs?: number;
  onStep?: (step: PurchaseStep) => void;
}

const nowSecs = () => Math.floor(Date.now() / 1000);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Ready {
  index: number;
  price: bigint;
  tx: Uint8Array;
  lastValidBlockHeight: number;
}

export async function buySpot(o: PurchaseOptions): Promise<PurchaseResult> {
  const nodeOpts: RpcOptions = { url: o.rpcUrl, ...(o.fetch ? { fetch: o.fetch } : {}) };
  o.onStep?.("checking");

  let ready: Ready | { refused: string };
  try {
    ready = await prepare(o, nodeOpts);
  } catch (err) {
    return { kind: "refused", reason: `Could not check the purchase, so nothing was sent: ${endSentence(errorText(err))}` };
  }
  if ("refused" in ready) return { kind: "refused", reason: ready.refused };

  const feature = (o.wallet.features as Partial<SolanaSignAndSendTransactionFeature>)[SolanaSignAndSendTransaction];
  if (!feature) return { kind: "declined", reason: `${displayName(o.wallet)} cannot send Solana transactions.` };

  o.onStep?.("waiting-for-wallet");
  let signature: string;
  try {
    const [out] = await feature.signAndSendTransaction({ account: o.account, transaction: ready.tx, chain: CHAIN });
    if (!out || out.signature.length !== 64) throw new Error("the wallet did not give back a transaction signature");
    signature = base58.encode(out.signature);
  } catch (err) {
    return { kind: "declined", reason: `${displayName(o.wallet)} did not send the transaction: ${endSentence(errorText(err))} If you approved it, check your wallet's history before trying again.` };
  }

  o.onStep?.("confirming");
  return confirm(o, nodeOpts, signature, ready);
}

/** Every check that can be made before the wallet is asked, then the transaction. Throws only when the node cannot be read. */
async function prepare(o: PurchaseOptions, nodeOpts: RpcOptions): Promise<Ready | { refused: string }> {
  const devnet = await checkDevnet(nodeOpts);
  if (!devnet.ok) return { refused: devnet.reason };

  if (!Number.isSafeInteger(o.breakNumber) || o.breakNumber < 1) return { refused: "That is not a break number." };
  const breakId = BigInt(o.breakNumber - 1);
  const [configAccount, breakAccount] = await getAccounts({ ...nodeOpts, addresses: [configAddress(o.program), breakAddress(o.program, breakId)], commitment: "confirmed" });
  if (!configAccount) return { refused: "The breaks program has not been set up on this network, so nothing was sent." };
  if (!breakAccount) return { refused: `Break #${o.breakNumber} does not exist, so nothing was sent.` };
  if (configAccount.owner !== o.program || breakAccount.owner !== o.program) return { refused: "The break or the config is not owned by the breaks program, so nothing was sent." };
  let config: ConfigAccount;
  let brk: BreakAccount;
  try {
    config = decodeConfig(configAccount.data);
    brk = decodeBreak(breakAccount.data);
  } catch (err) {
    return { refused: `The break could not be read (${errorText(err)}), so nothing was sent.` };
  }
  if (brk.id !== breakId) return { refused: "The account found for this break says it is another break, so nothing was sent." };

  const sale = checkSale({ config, break: brk, now: (o.now ?? nowSecs)() });
  if (!sale.ok) return { refused: sale.reason };

  const usdc = await loadUsdcBalance({ rpcUrl: o.rpcUrl, program: o.program, owner: o.account.address, commitment: "confirmed", ...(o.fetch ? { fetch: o.fetch } : {}) });
  const afford = checkAfford(sale.price, usdc.balance);
  if (!afford.ok) return { refused: afford.reason };

  // The purchase creates an account for the spot and pays the fee, and what is left of the wallet must still be a valid account.
  const [lamports, rentSpot, rentBare] = await Promise.all([
    rpc<{ value?: unknown }>(nodeOpts, "getBalance", [o.account.address, { commitment: "confirmed" }]).then((r) => integer(r?.value, "the wallet's SOL balance")),
    rentExempt(nodeOpts, SPOT_ACCOUNT_BYTES, "the rent of a spot account"),
    rentExempt(nodeOpts, 0, "the rent of a wallet"),
  ]);
  const need = rentSpot + SIGNATURE_FEE_LAMPORTS + rentBare;
  if (lamports < need) return { refused: `This wallet needs about ${sol(need)} for the new spot's account and the network fee, and has ${sol(lamports)}.` };

  const latest = await rpc<{ value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } }>(nodeOpts, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const blockhash = latest?.value?.blockhash;
  const lastValid = latest?.value?.lastValidBlockHeight;
  if (typeof blockhash !== "string" || typeof lastValid !== "number") throw new Error("the node did not give a recent blockhash");

  const instruction = buySpotInstruction({ program: o.program, buyer: o.account.address, buyerUsdc: usdc.account, breakId, index: sale.index });
  const built = buildTransaction({ feePayer: o.account.address, recentBlockhash: blockhash, instructions: [instruction] });
  return { index: sale.index, price: sale.price, tx: built.unsigned, lastValidBlockHeight: lastValid };
}

function integer(value: unknown, what: string): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`the node did not give ${what}`);
  return BigInt(value);
}

/** What the node asks to keep an account of `bytes` bytes alive. */
const rentExempt = (nodeOpts: RpcOptions, bytes: number, what: string): Promise<bigint> =>
  rpc<unknown>(nodeOpts, "getMinimumBalanceForRentExemption", [bytes]).then((r) => integer(r, what));

export interface SaleTerms {
  /** The admin has paused sales. */
  paused: boolean;
  /** The SOL a purchase costs besides the USDC: the rent of the new spot account and the network fee. */
  solCost: bigint;
}

/**
 * What the buy panel shows before anyone clicks: whether sales are paused, and the SOL a purchase costs next to its USDC, so the
 * buyer knows the whole price before the wallet asks. The purchase itself checks everything again; this only informs the page.
 */
export async function loadSaleTerms(o: { rpcUrl: string; program: Address; fetch?: typeof fetch }): Promise<SaleTerms> {
  const nodeOpts: RpcOptions = { url: o.rpcUrl, ...(o.fetch ? { fetch: o.fetch } : {}) };
  try {
    const [[config], rent] = await Promise.all([
      getAccounts({ ...nodeOpts, addresses: [configAddress(o.program)], commitment: "confirmed" }),
      rentExempt(nodeOpts, SPOT_ACCOUNT_BYTES, "the rent of a spot account"),
    ]);
    if (!config) throw new LoadError("The breaks program has not been set up on this network (its config account does not exist).");
    if (config.owner !== o.program) throw new LoadError("The config account is not owned by the breaks program.");
    let decoded: ConfigAccount;
    try {
      decoded = decodeConfig(config.data);
    } catch (err) {
      throw new LoadError(`The config account could not be read: ${errorText(err)}`);
    }
    return { paused: decoded.paused, solCost: rent + SIGNATURE_FEE_LAMPORTS };
  } catch (err) {
    if (err instanceof LoadError) throw err;
    if (err instanceof RpcFailure) throw new LoadError(err.message);
    throw new LoadError(`Could not read the sale terms: ${errorText(err)}`);
  }
}

interface SignatureStatus {
  err: unknown;
  confirmationStatus?: string | null;
}

/** Waits for the network to say what became of the transaction. A node that fails to answer is asked again; only the time running out stops it. */
async function confirm(o: PurchaseOptions, nodeOpts: RpcOptions, signature: string, ready: Ready): Promise<PurchaseResult> {
  const clock = o.clock ?? Date.now;
  const sleep = o.sleep ?? wait;
  const timeout = o.confirmTimeoutMs ?? 60_000;
  const pollMs = o.pollMs ?? 1500;
  const started = clock();
  let lastError = "";
  for (let poll = 0; ; poll++) {
    try {
      const res = await rpc<{ value?: (SignatureStatus | null)[] }>(nodeOpts, "getSignatureStatuses", [[signature], { searchTransactionHistory: false }]);
      const status = res?.value?.[0] ?? null;
      if (status) {
        if (status.err !== null && status.err !== undefined) return { kind: "failed", signature, reason: describeTransactionError(status.err) };
        if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") return { kind: "bought", signature, index: ready.index, price: ready.price };
      } else if (poll % 4 === 3) {
        // Not heard of: once the chain is past the blockhash's last valid height, it can no longer land.
        const height = await rpc<unknown>(nodeOpts, "getBlockHeight", [{ commitment: "confirmed" }]);
        if (typeof height === "number" && height > ready.lastValidBlockHeight) {
          return { kind: "failed", signature, reason: "The transaction expired before it landed, so nothing was bought. You can try again." };
        }
      }
    } catch (err) {
      lastError = errorText(err);
    }
    if (clock() - started >= timeout) {
      const why = lastError ? ` The last attempt to ask the network failed: ${endSentence(lastError)}` : "";
      return { kind: "unconfirmed", signature, reason: `The network has not confirmed the transaction yet. It may still land, so check your wallet's history or the explorer before trying again.${why}` };
    }
    await sleep(pollMs);
  }
}
