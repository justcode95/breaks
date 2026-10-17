// The per-spot ledger on a break's page. Pure: it takes what `loadLedger` found and draws it; nothing here reads or checks.

import { explorerTxUrl } from "../../../lib/chain/buy";
import { money } from "../../../lib/chain/view";
import type { LedgerState } from "../../../lib/ledger";
import { shortAddress } from "../../../lib/wallet/wallets";

export type LedgerViewState = LedgerState | { kind: "off" } | { kind: "loading" };

/** A transaction as a link to the devnet explorer when it looks like a signature, otherwise as text (it came from the host). */
function Tx({ signature, label }: { signature: string; label: string }) {
  const url = explorerTxUrl(signature);
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" title={signature}>
      {label}
    </a>
  ) : (
    <>
      {label}{" "}
      <code className="mono" title={signature}>
        {shortAddress(signature)}
      </code>
    </>
  );
}

const Short = ({ address }: { address: string }) => (
  <code className="mono" title={address}>
    {shortAddress(address)}
  </code>
);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function LedgerSection({ state, host, fileUrl, budget, onRetry }: { state: LedgerViewState; host: string; fileUrl?: string; budget: bigint; onRetry?: () => void }) {
  if (state.kind === "not-drawn") return null;
  return (
    <section className="card">
      <h2>Per-spot ledger</h2>
      <p className="hint">
        For each spot: the pack bought for it, the card that came out, and the transaction that sent the card to the spot's wallet.
        Which card goes to which spot is decided by the draw, not by anyone.
      </p>
      <LedgerBody state={state} host={host} {...(fileUrl ? { fileUrl } : {})} budget={budget} {...(onRetry ? { onRetry } : {})} />
    </section>
  );
}

function LedgerBody({ state, host, fileUrl, budget, onRetry }: { state: Exclude<LedgerViewState, { kind: "not-drawn" }>; host: string; fileUrl?: string; budget: bigint; onRetry?: () => void }) {
  switch (state.kind) {
    case "off":
      return <p>This site is not set up to read the published lists, so the ledger cannot be shown here.</p>;
    case "loading":
      return <p>Reading the ledger…</p>;
    case "unavailable":
      return (
        <>
          <p>
            {state.why === "missing"
              ? `It is not published at ${host} yet. The keeper publishes it once every card of the break is delivered, which happens right after the draw.`
              : state.why === "unreachable"
                ? `It could not be read or checked (${state.message}).`
                : `The file at ${host} is not a ledger this page can use (${state.message}), so it is not shown.`}
          </p>
          {state.why !== "invalid" && onRetry && (
            <div className="actions">
              <button type="button" className="secondary" onClick={onRetry}>Read the ledger again</button>
            </div>
          )}
        </>
      );
    case "wrong":
      return (
        <>
          <div className="verdict bad" role="alert">The ledger at {host} does not agree with the chain, so it is not shown.</div>
          <ul>
            {state.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {fileUrl && <p className="hint"><a href={fileUrl}>The file as published</a></p>}
        </>
      );
    case "checked": {
      const { ledger, check } = state;
      const unspent = check.cost.unknown === 0 && check.cost.known < budget ? budget - check.cost.known : 0n;
      const known = ledger.packs.length - check.cost.unknown;
      return (
        <>
          <div className="verdict ok" role="status">
            Every spot's wallet and card agree with the chain and the draw, the cards are the committed pool, and no pack cost more than its cap.
          </div>
          <div className="table-wrap" role="region" aria-label="Per-spot ledger" tabIndex={0}>
            <table className="roomy">
              <caption>Paid spots in purchase order, then free spots in draw order</caption>
              <thead>
                <tr>
                  <th scope="col">Spot</th>
                  <th scope="col">Wallet</th>
                  <th scope="col">Card</th>
                  <th scope="col">Pack</th>
                  <th scope="col">Sent</th>
                </tr>
              </thead>
              <tbody>
                {check.rows.map(({ spot, pack }) => (
                  <tr key={`${spot.kind}-${spot.index}`}>
                    <th scope="row">{spot.kind === "paid" ? "Paid" : "Free"} #{spot.index + 1}</th>
                    <td><Short address={spot.wallet} /></td>
                    <td><Short address={spot.card} /></td>
                    <td>
                      {pack ? (
                        <>
                          #{pack.index + 1}, <span className="num">{pack.price === undefined ? "price not known" : money(pack.price)}</span>
                          <span className="block"><Tx signature={pack.purchaseTx} label="purchase" /></span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{spot.deliveryTx === undefined ? "found at the wallet" : <Tx signature={spot.deliveryTx} label="transfer" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl>
            <dt>Buyer wallet</dt>
            <dd><code className="mono wrap">{ledger.buyer}</code></dd>
            <dt>What the packs cost</dt>
            <dd>
              {known === 0 ? (
                `${plural(ledger.packs.length, "pack", "packs")}, whose ${ledger.packs.length === 1 ? "price is" : "prices are"} not known`
              ) : (
                <>
                  {plural(known, "pack", "packs")} for <span className="num">{money(check.cost.known)}</span>
                  {check.cost.unknown > 0 && `, plus ${plural(check.cost.unknown, "pack", "packs")} whose price is not known`}
                </>
              )}
              . The program paid{" "}
              <span className="num">{money(budget)}</span> to the buyer wallet for them, the most each pack could cost.
              {unspent > 0n && <> <span className="num">{money(unspent)}</span> of it was not spent on packs.</>}
            </dd>
          </dl>
          <p className="hint">
            The transactions are the keeper's word: open each one to see that it bought that pack, or sent that card from the buyer wallet
            to that wallet. A card found at its wallet has no transfer on record. Everything else here is checked against the chain.
            {fileUrl && (
              <>
                {" "}
                <a href={fileUrl}>The file as published</a>.
              </>
            )}
          </p>
        </>
      );
    }
  }
}
