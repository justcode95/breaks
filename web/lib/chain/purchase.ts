// Buying a paid spot from the site, from the first check to the confirmation. Every check that can be made without the wallet
// is made first, and nothing is put in front of the wallet until they pass; after the wallet has the transaction, the outcome is
// said as exactly as it is known: bought, refused by the network, expired, or not heard of yet. Nothing here is specific to a
// page: the page passes in the wallet and gets a result back. Devnet only: the node is asked which network it is, first.

import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { endSentence, errorText } from "../wallet/wallets";
import { type BreakAccount, type ConfigAccount, SPOT_ACCOUNT_BYTES, decodeBreak, decodeConfig } from "./accounts";
import { type Address, breakAddress, configAddress } from "./address";
import { loadUsdcBalance } from "./balance";
import { buySpotInstruction, checkAfford, checkSale } from "./buy";
import { checkDevnet } from "./cluster";
import { LoadError } from "./load";
import { type RpcOptions, RpcFailure, getAccounts } from "./rpc";
import { BREAKS_ERRORS, SIGNATURE_FEE_LAMPORTS, type Timing, describeTransactionError, latestBlockhash, rentExempt, signAndSend, solBalance, watchTransaction } from "./send";
import { buildTransaction } from "./transaction";
import { sol } from "./view";

// These moved to send.ts with the code they belong to; they are still found here.
export { BREAKS_ERRORS, SIGNATURE_FEE_LAMPORTS, SPOT_ACCOUNT_BYTES, describeTransactionError };
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

export interface PurchaseOptions extends Timing {
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
  onStep?: (step: PurchaseStep) => void;
}

const nowSecs = () => Math.floor(Date.now() / 1000);

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

  o.onStep?.("waiting-for-wallet");
  const sent = await signAndSend(o.wallet, o.account, ready.tx);
  if (!sent.ok) return { kind: "declined", reason: sent.reason };

  o.onStep?.("confirming");
  const watched = await watchTransaction(nodeOpts, sent.signature, ready.lastValidBlockHeight, "buy", o);
  if (watched.kind === "confirmed") return { kind: "bought", signature: sent.signature, index: ready.index, price: ready.price };
  return { kind: watched.kind, signature: sent.signature, reason: watched.reason };
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
    solBalance(nodeOpts, o.account.address),
    rentExempt(nodeOpts, SPOT_ACCOUNT_BYTES, "the rent of a spot account"),
    rentExempt(nodeOpts, 0, "the rent of a wallet"),
  ]);
  const need = rentSpot + SIGNATURE_FEE_LAMPORTS + rentBare;
  if (lamports < need) return { refused: `This wallet needs about ${sol(need)} for the new spot's account and the network fee, and has ${sol(lamports)}.` };

  const latest = await latestBlockhash(nodeOpts);

  const instruction = buySpotInstruction({ program: o.program, buyer: o.account.address, buyerUsdc: usdc.account, breakId, index: sale.index });
  const built = buildTransaction({ feePayer: o.account.address, recentBlockhash: latest.blockhash, instructions: [instruction] });
  return { index: sale.index, price: sale.price, tx: built.unsigned, lastValidBlockHeight: latest.lastValidBlockHeight };
}

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
