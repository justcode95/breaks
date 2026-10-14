import type { BreakAccount } from "../../../lib/chain/accounts";
import type { BuyState } from "../../../lib/chain/buy-state";
import { checkAfford, checkSale, explorerTxUrl } from "../../../lib/chain/buy";
import type { PurchaseResult, PurchaseStep, SaleTerms } from "../../../lib/chain/purchase";
import { money, sol } from "../../../lib/chain/view";
import { shortAddress } from "../../../lib/wallet/wallets";

/** What the panel knows about the sale's terms (whether sales are paused, the SOL a purchase costs next to its USDC). */
export type TermsView = { kind: "loading" } | { kind: "loaded"; terms: SaleTerms } | { kind: "error"; message: string };
/** What the panel knows about the connected wallet's USDC. */
export type UsdcView = { kind: "loading" } | { kind: "loaded"; balance: bigint | null } | { kind: "error"; message: string };
export type WalletView = { kind: "none" } | { kind: "connecting" } | { kind: "connected"; address: string };

export interface BuyPanelViewProps {
  b: BreakAccount;
  /** Seconds since 1970, for the sale window. */
  now: number;
  terms: TermsView;
  wallet: WalletView;
  usdc: UsdcView;
  buy: BuyState;
  onBuy: () => void;
  /** Reads the wallet's USDC again. */
  onRetry: () => void;
  /** Closes the result of a purchase. */
  onDismiss: () => void;
}

const STEPS: Record<PurchaseStep, string> = {
  checking: "Checking the sale, your balances and the network…",
  "waiting-for-wallet": "Approve the purchase in your wallet. Nothing is bought until you do.",
  confirming: "Sent. Waiting for the network to confirm it…",
};

function Explorer({ signature }: { signature: string }) {
  const url = explorerTxUrl(signature);
  return url ? (
    <p className="hint">
      <a href={url} target="_blank" rel="noopener noreferrer">
        See the transaction on the explorer
      </a>
    </p>
  ) : null;
}

function Result({ result, address, seen, onDismiss }: { result: PurchaseResult; address: string; seen: boolean; onDismiss: () => void }) {
  switch (result.kind) {
    case "bought":
      return (
        <>
          <p className="buy-result good" role="status">
            <strong>Spot #{result.index + 1} is yours.</strong> You paid {money(result.price)} in USDC with {shortAddress(address)}.
          </p>
          <p className="hint">{seen ? "The page above now shows it." : "The chain is still finalizing it; the page above updates in a few seconds."}</p>
          <Explorer signature={result.signature} />
          <div className="actions">
            <button type="button" className="secondary" onClick={onDismiss}>Close</button>
          </div>
        </>
      );
    case "refused":
      return (
        <>
          <p className="problem" role="alert"><strong>Not bought.</strong> {result.reason}</p>
          <p className="hint">Your wallet was not asked to sign anything.</p>
          <div className="actions">
            <button type="button" className="secondary" onClick={onDismiss}>Try again</button>
          </div>
        </>
      );
    case "declined":
      return (
        <>
          <p className="problem" role="alert"><strong>The wallet did not confirm sending it.</strong> {result.reason}</p>
          <div className="actions">
            <button type="button" className="secondary" onClick={onDismiss}>Close</button>
          </div>
        </>
      );
    case "failed":
      return (
        <>
          <p className="problem" role="alert"><strong>Not bought.</strong> {result.reason}</p>
          <p className="hint">No USDC was spent.</p>
          <Explorer signature={result.signature} />
          <div className="actions">
            <button type="button" className="secondary" onClick={onDismiss}>Try again</button>
          </div>
        </>
      );
    case "unconfirmed":
      return (
        <>
          <p className="problem" role="alert"><strong>Not confirmed yet.</strong> {result.reason}</p>
          <Explorer signature={result.signature} />
          <div className="actions">
            <button type="button" className="secondary" onClick={onDismiss}>Close</button>
          </div>
        </>
      );
  }
}

/** The SOL a purchase costs on top of its USDC, in words, for as far as it is known. */
function solLine(terms: TermsView): string {
  if (terms.kind === "loaded") return `plus about ${sol(terms.terms.solCost)} for the new spot's account and the network fee`;
  return "plus a little devnet SOL for the new spot's account and the network fee";
}

/**
 * The card where a visitor buys a paid spot: what it costs (all of it, before the wallet asks), what stands in the way, the
 * button, the progress of a purchase and how it ended. Pure: the state comes in and the clicks go out. Nothing here is sent
 * anywhere; `BuyPanel` runs the purchase.
 */
export function BuyPanelView({ b, now, terms, wallet, usdc, buy, onBuy, onRetry, onDismiss }: BuyPanelViewProps) {
  // A break that is not on sale has no buy card, unless a purchase made here is still being shown.
  if (buy.status === "idle" && b.status !== "Open") return null;

  return (
    <section className="card buy" aria-labelledby="buy-title">
      <h2 id="buy-title">Buy a spot</h2>
      {buy.status === "running" ? (
        <p className="buy-progress" role="status">{STEPS[buy.step]}</p>
      ) : buy.status === "finished" ? (
        <Result result={buy.result} address={buy.address} seen={buy.seen} onDismiss={onDismiss} />
      ) : (
        <Sale b={b} now={now} terms={terms} wallet={wallet} usdc={usdc} onBuy={onBuy} onRetry={onRetry} />
      )}
    </section>
  );
}

function Sale({ b, now, terms, wallet, usdc, onBuy, onRetry }: Pick<BuyPanelViewProps, "b" | "now" | "terms" | "wallet" | "usdc" | "onBuy" | "onRetry">) {
  // Until the terms are read, sales count as running; the purchase asks the program's config again before anything is sent.
  const sale = checkSale({ config: { paused: terms.kind === "loaded" && terms.terms.paused }, break: b, now });
  if (!sale.ok) return <p>{sale.reason}</p>;

  const afford = wallet.kind === "connected" && usdc.kind === "loaded" ? checkAfford(sale.price, usdc.balance) : undefined;
  return (
    <>
      <p className="buy-price">
        <span className="amount">{money(sale.price)}</span> in USDC for a paid spot
      </p>
      <p className="hint">
        {sale.spotsLeft} of {b.paidSpots} left, {solLine(terms)}. Your wallet shows the final amounts before you approve.
        {terms.kind === "error" && ` (Could not read the exact SOL amount: ${terms.message})`}
      </p>
      {wallet.kind === "none" && <p>Connect a wallet with the button at the top of the page to buy a spot.</p>}
      {wallet.kind === "connecting" && <p>Waiting for the wallet to connect…</p>}
      {wallet.kind === "connected" && (
        <>
          {usdc.kind === "loading" && <p>Reading your USDC balance…</p>}
          {usdc.kind === "error" && (
            <>
              <p className="problem">Could not read your USDC balance: {usdc.message}</p>
              <div className="actions">
                <button type="button" className="secondary" onClick={onRetry}>Try again</button>
              </div>
            </>
          )}
          {usdc.kind === "loaded" && (
            <p>
              Your USDC: <strong>{usdc.balance === null ? "none" : money(usdc.balance)}</strong> ({shortAddress(wallet.address)})
            </p>
          )}
          {afford && !afford.ok && <p className="problem">{afford.reason}</p>}
          {afford?.ok && (
            <div className="actions">
              <button type="button" onClick={onBuy}>Buy a spot for {money(sale.price)}</button>
            </div>
          )}
        </>
      )}
    </>
  );
}
