// Refunding a paid spot of a cancelled break from the site. The program lets anyone send a refund and always pays the spot's owner
// (`refund_spot` takes no signer: the sender only pays the network fee), so this is the least that can go wrong with money: the
// USDC goes back to the owner's own USDC account or the transaction fails. A wallet with no USDC account (one it closed, say) has
// one opened in the same transaction, at its own cost: the rent stays in the new account, which is the wallet's. Even so it follows
// the buy flow's rules: every check that can be made without the wallet is made first, the wallet is asked last, and the outcome
// is said as exactly as it is known. This site only sends refunds for the connected wallet's own spots. Devnet only: the node is
// asked which network it is, first.

import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { endSentence, errorText } from "../wallet/wallets";
import { type BreakAccount, type SpotAccount, decodeBreak, decodeSpot } from "./accounts";
import { type Address, TOKEN_PROGRAM, breakAddress, escrowAddress, spotAddress } from "./address";
import { loadUsdcBalance } from "./balance";
import { type Instruction, discriminator } from "./buy";
import { checkDevnet } from "./cluster";
import type { PurchaseStep } from "./purchase";
import { type RpcOptions, getAccounts } from "./rpc";
import { SIGNATURE_FEE_LAMPORTS, type Timing, latestBlockhash, rentExempt, signAndSend, solBalance, watchTransaction } from "./send";
import { TOKEN_ACCOUNT_BYTES, openTokenAccountInstruction } from "./token-account";
import { buildTransaction } from "./transaction";
import { sol } from "./view";

/**
 * `refund_spot()`: pays the spot's price from the break's escrow to `ownerUsdc`, which has to be a USDC account of the spot's
 * owner (the program refuses any other), and marks the spot refunded. No account signs: the transaction's fee payer is all it
 * needs. Byte for byte the Rust program's own `breaks.refund_spot` vector.
 */
export function refundSpotInstruction(a: { program: Address; breakId: bigint; index: number; ownerUsdc: Address }): Instruction {
  const breakKey = breakAddress(a.program, a.breakId);
  return {
    programId: a.program,
    accounts: [
      { pubkey: breakKey, signer: false, writable: false },
      { pubkey: escrowAddress(a.program, breakKey), signer: false, writable: true },
      { pubkey: spotAddress(a.program, breakKey, a.index), signer: false, writable: true },
      { pubkey: a.ownerUsdc, signer: false, writable: true },
      { pubkey: TOKEN_PROGRAM, signer: false, writable: false },
    ],
    data: discriminator("refund_spot"),
  };
}

export type RefundCheck = { ok: true; amount: bigint } | { ok: false; reason: string };

/** Whether the program would take a refund now, in the program's order: the break is cancelled, and the spot is not refunded yet. */
export function checkRefund(c: { break: Pick<BreakAccount, "status">; spot: Pick<SpotAccount, "paid" | "refunded"> }): RefundCheck {
  if (c.break.status !== "Cancelled") return { ok: false, reason: "This break was not cancelled, so nothing is refunded." };
  if (c.spot.refunded) return { ok: false, reason: "This spot was already refunded." };
  return { ok: true, amount: c.spot.paid };
}

export type RefundResult =
  /** The network confirmed it: the spot's price is back in the owner's USDC account (`opened` by this transaction, or not). */
  | { kind: "refunded"; signature: string; amount: bigint; opened: boolean }
  /** A check failed before the wallet was asked: nothing was sent. */
  | { kind: "refused"; reason: string }
  /** The wallet did not send it, or said no. (If it did send it, the wallet's history shows it.) */
  | { kind: "declined"; reason: string }
  /** It reached the network and was refused, or it expired before it landed: nothing was refunded. */
  | { kind: "failed"; signature: string; reason: string }
  /** The wallet sent it but the network has not said anything yet: it may still land. */
  | { kind: "unconfirmed"; signature: string; reason: string };

export interface RefundOptions extends Timing {
  rpcUrl: string;
  /** The breaks program. */
  program: Address;
  /** The number people see for the break: the on-chain id + 1. */
  breakNumber: number;
  /** The spot, counting from 0. */
  index: number;
  wallet: Wallet;
  account: WalletAccount;
  fetch?: typeof fetch;
  onStep?: (step: PurchaseStep) => void;
}

interface Ready {
  amount: bigint;
  /** The transaction opens the owner's USDC account first. */
  opened: boolean;
  tx: Uint8Array;
  lastValidBlockHeight: number;
}

export async function refundSpot(o: RefundOptions): Promise<RefundResult> {
  const nodeOpts: RpcOptions = { url: o.rpcUrl, ...(o.fetch ? { fetch: o.fetch } : {}) };
  o.onStep?.("checking");

  let ready: Ready | { refused: string };
  try {
    ready = await prepare(o, nodeOpts);
  } catch (err) {
    return { kind: "refused", reason: `Could not check the refund, so nothing was sent: ${endSentence(errorText(err))}` };
  }
  if ("refused" in ready) return { kind: "refused", reason: ready.refused };

  o.onStep?.("waiting-for-wallet");
  const sent = await signAndSend(o.wallet, o.account, ready.tx);
  if (!sent.ok) return { kind: "declined", reason: sent.reason };

  o.onStep?.("confirming");
  const watched = await watchTransaction(nodeOpts, sent.signature, ready.lastValidBlockHeight, "refund", o);
  if (watched.kind === "confirmed") return { kind: "refunded", signature: sent.signature, amount: ready.amount, opened: ready.opened };
  return { kind: watched.kind, signature: sent.signature, reason: watched.reason };
}

/** Every check that can be made before the wallet is asked, then the transaction. Throws only when the node cannot be read. */
async function prepare(o: RefundOptions, nodeOpts: RpcOptions): Promise<Ready | { refused: string }> {
  const devnet = await checkDevnet(nodeOpts);
  if (!devnet.ok) return { refused: devnet.reason };

  if (!Number.isSafeInteger(o.breakNumber) || o.breakNumber < 1) return { refused: "That is not a break number." };
  if (!Number.isSafeInteger(o.index) || o.index < 0 || o.index > 0xffff) return { refused: "That is not a spot." };
  const breakId = BigInt(o.breakNumber - 1);
  const breakKey = breakAddress(o.program, breakId);
  const [breakAccount, spotAccount] = await getAccounts({ ...nodeOpts, addresses: [breakKey, spotAddress(o.program, breakKey, o.index)], commitment: "confirmed" });
  if (!breakAccount) return { refused: `Break #${o.breakNumber} does not exist, so nothing was sent.` };
  if (!spotAccount) return { refused: `Spot #${o.index + 1} of break #${o.breakNumber} does not exist, so nothing was sent.` };
  if (breakAccount.owner !== o.program || spotAccount.owner !== o.program) return { refused: "The break or the spot is not owned by the breaks program, so nothing was sent." };
  let brk: BreakAccount;
  let spot: SpotAccount;
  try {
    brk = decodeBreak(breakAccount.data);
    spot = decodeSpot(spotAccount.data);
  } catch (err) {
    return { refused: `The break or the spot could not be read (${errorText(err)}), so nothing was sent.` };
  }
  if (brk.id !== breakId || spot.breakId !== breakId || spot.index !== o.index) return { refused: "The accounts found say they are another break or spot, so nothing was sent." };
  if (spot.owner !== o.account.address) return { refused: "This spot belongs to another wallet. This site only sends refunds for the connected wallet's own spots, so nothing was sent." };

  const refund = checkRefund({ break: brk, spot });
  if (!refund.ok) return { refused: refund.reason };

  // The refund goes to the owner's own USDC account. When it has none, this transaction opens it first.
  const usdc = await loadUsdcBalance({ rpcUrl: o.rpcUrl, program: o.program, owner: spot.owner, commitment: "confirmed", ...(o.fetch ? { fetch: o.fetch } : {}) });
  const opens = usdc.balance === null;

  // The wallet pays the network fee and, when the account is opened, its rent; what is left of it must still be a valid account.
  const [lamports, rentBare, rentAccount] = await Promise.all([
    solBalance(nodeOpts, o.account.address),
    rentExempt(nodeOpts, 0, "the rent of a wallet"),
    opens ? rentExempt(nodeOpts, TOKEN_ACCOUNT_BYTES, "the rent of a token account") : Promise.resolve(0n),
  ]);
  const need = SIGNATURE_FEE_LAMPORTS + rentBare + rentAccount;
  if (lamports < need) {
    return { refused: `This wallet needs about ${sol(need)} for the network fee${opens ? " and the rent of the USDC account this refund opens" : ""}, and has ${sol(lamports)}.` };
  }

  const latest = await latestBlockhash(nodeOpts);
  const instructions = [
    ...(opens ? [openTokenAccountInstruction({ payer: o.account.address, owner: spot.owner, mint: usdc.mint })] : []),
    refundSpotInstruction({ program: o.program, breakId, index: o.index, ownerUsdc: usdc.account }),
  ];
  const built = buildTransaction({ feePayer: o.account.address, recentBlockhash: latest.blockhash, instructions });
  return { amount: refund.amount, opened: opens, tx: built.unsigned, lastValidBlockHeight: latest.lastValidBlockHeight };
}

/** What a refund costs the wallet beyond the network fee: nothing, or the rent of the USDC account it opens. */
export type RefundTerms = { opens: false } | { opens: true; rent: bigint };

/** Whether a refund to `owner` would open its USDC account, and what that account's rent is. Throws when the node cannot be read. */
export async function loadRefundTerms(o: { rpcUrl: string; program: Address; owner: Address; fetch?: typeof fetch }): Promise<RefundTerms> {
  const usdc = await loadUsdcBalance({ rpcUrl: o.rpcUrl, program: o.program, owner: o.owner, commitment: "confirmed", ...(o.fetch ? { fetch: o.fetch } : {}) });
  if (usdc.balance !== null) return { opens: false };
  return { opens: true, rent: await rentExempt({ url: o.rpcUrl, ...(o.fetch ? { fetch: o.fetch } : {}) }, TOKEN_ACCOUNT_BYTES, "the rent of a token account") };
}
