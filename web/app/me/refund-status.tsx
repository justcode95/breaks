import type { RefundState } from "../../lib/chain/refund-state";
import { explorerTxUrl } from "../../lib/chain/buy";
import { money } from "../../lib/chain/view";
import { shortAddress } from "../../lib/wallet/wallets";

const STEPS = {
  checking: "Checking the break, the spot and your balances…",
  "waiting-for-wallet": "Approve the refund in your wallet. Nothing is sent until you do.",
  confirming: "Sent. Waiting for the network to confirm it…",
} as const;

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

/**
 * Where a refund stands: progress while it runs, and how it ended, exactly as `refundSpot` knows it. Nothing while idle. Pure: the
 * state comes in and the click goes out. The same rules of speech as the buy card: "refunded" only when the network said so, and
 * a wallet that did not confirm is not told "not refunded", since it may have sent the transaction anyway.
 */
export function RefundStatusView({ state, onDismiss }: { state: RefundState; onDismiss: () => void }) {
  if (state.status === "idle") return null;
  const which = `spot #${state.index + 1} of break #${state.breakNumber}`;
  return (
    <section className="card buy" aria-labelledby="refund-title">
      <h2 id="refund-title">Refund</h2>
      {state.status === "running" ? (
        <>
          <p className="hint">Refunding {which}.</p>
          <p className="buy-progress" role="status">{STEPS[state.step]}</p>
        </>
      ) : (
        <>
          {state.result.kind === "refunded" && (
            <>
              <p className="buy-result good" role="status">
                <strong>Refunded.</strong> {money(state.result.amount)} is back in the USDC account of {shortAddress(state.address)} for {which}.
              </p>
              <p className="hint">{state.seen ? "The list below now shows it as refunded." : "The chain is still finalizing it; the list below updates in a few seconds."}</p>
              <Explorer signature={state.result.signature} />
            </>
          )}
          {state.result.kind === "refused" && (
            <>
              <p className="problem" role="alert"><strong>Not refunded.</strong> {state.result.reason}</p>
              <p className="hint">Your wallet was not asked to sign anything.</p>
            </>
          )}
          {state.result.kind === "declined" && (
            <p className="problem" role="alert"><strong>The wallet did not confirm sending it.</strong> {state.result.reason}</p>
          )}
          {state.result.kind === "failed" && (
            <>
              <p className="problem" role="alert"><strong>Not refunded.</strong> {state.result.reason}</p>
              <p className="hint">No USDC was moved by this attempt.</p>
              <Explorer signature={state.result.signature} />
            </>
          )}
          {state.result.kind === "unconfirmed" && (
            <>
              <p className="problem" role="alert"><strong>Not confirmed yet.</strong> {state.result.reason}</p>
              <Explorer signature={state.result.signature} />
            </>
          )}
          <div className="actions">
            <button type="button" className="secondary" onClick={onDismiss}>Close</button>
          </div>
        </>
      )}
    </section>
  );
}
