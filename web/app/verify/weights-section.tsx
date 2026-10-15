// What the balance events say about the weights on the eligibility list, for the verify page's result. Pure: it takes what
// `verifyDraw` worked out and draws it; nothing here reads or computes anything.

import type { WeightsReport } from "../../lib/verify";

/** The most rows of a table of wallets that are shown at once: a list may have thousands, and nearly all of them are as they should be. */
export const MOST_ROWS = 50;
/** How many of the wallets that are not on the list are shown. */
export const MOST_OFF_LIST = 10;

const STATUS_TEXT = { equal: "✓ equal", below: "below the average balance", above: "✗ above the average balance", "no-history": "✗ no balance events" } as const;

export function WeightsSection({ weights }: { weights: WeightsReport }) {
  if (!weights.ok) {
    return (
      <>
        <h3>Weights from the balance events</h3>
        <div className="verdict bad" role="alert">The weights could not be checked.</div>
        <ul>
          {weights.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </>
    );
  }
  const { check, events } = weights;
  const listed = check.rows.length;
  const odd = check.rows.filter((r) => r.status !== "equal");
  const unexplained = check.rows.filter((r) => r.status === "above" || r.status === "no-history");
  const verdict =
    listed === 0
      ? { tone: "ok", text: "Nobody is on the list." }
      : check.verdict === "equal"
        ? { tone: "ok", text: listed === 1 ? "The one weight on the list is its wallet's time-weighted average balance over the window." : `Every one of the ${listed} weights on the list is its wallet's time-weighted average balance over the window.` }
        : check.verdict === "capped"
          ? {
              tone: "ok",
              text: `No weight is above its wallet's average balance, but ${check.counts.below} of ${listed} ${check.counts.below === 1 ? "is" : "are"} below it. Only a cap on a wallet's weight explains that, and whether a cap applies is still being decided.`,
            }
          : {
              tone: "bad",
              text: `${unexplained.length} of ${listed} ${listed === 1 ? "weight" : "weights"} cannot be explained by these balance events: ${[
                check.counts.above > 0 ? `${check.counts.above} above the average balance` : "",
                check.counts["no-history"] > 0 ? `${check.counts["no-history"]} for ${check.counts["no-history"] === 1 ? "a wallet" : "wallets"} with no balance events` : "",
              ]
                .filter(Boolean)
                .join(" and ")}.`,
            };
  return (
    <>
      <h3>Weights from the balance events</h3>
      <div className={`verdict ${verdict.tone}`} role="status">{verdict.text}</div>
      <p className="hint">
        {events} balance {events === 1 ? "event" : "events"} read; the average is taken over the window from {weights.window.start} to {weights.window.end} (Unix seconds) and rounded down to a whole base unit.
      </p>

      {odd.length > 0 && (
        <div className="scroll" role="region" aria-label="Weights that are not their wallet's average balance" tabIndex={0}>
          <table>
            <caption>Weights that are not their wallet's average balance</caption>
            <thead>
              <tr>
                <th scope="col">Wallet</th>
                <th scope="col">Weight on the list</th>
                <th scope="col">Average balance</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {odd.slice(0, MOST_ROWS).map((r) => (
                <tr key={r.wallet}>
                  <th scope="row" className="mono wrap">{r.wallet}</th>
                  <td className="mono">{r.weight.toString()}</td>
                  <td className="mono">{r.twab === undefined ? "none" : r.twab.toString()}</td>
                  <td>{STATUS_TEXT[r.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {odd.length > MOST_ROWS && <p className="hint">… and {odd.length - MOST_ROWS} more.</p>}

      {check.offList.length > 0 && (
        <>
          <p>
            {check.offList.length} {check.offList.length === 1 ? "wallet has" : "wallets have"} an average balance above zero but {check.offList.length === 1 ? "is" : "are"} not on the list: below the minimum, or left out on purpose. The reasons are not published yet.
          </p>
          <div className="scroll" role="region" aria-label="Wallets with an average balance that are not on the list" tabIndex={0}>
            <table>
              <caption>Not on the list, biggest average balance first</caption>
              <thead>
                <tr>
                  <th scope="col">Wallet</th>
                  <th scope="col">Average balance</th>
                </tr>
              </thead>
              <tbody>
                {check.offList.slice(0, MOST_OFF_LIST).map((r) => (
                  <tr key={r.wallet}>
                    <th scope="row" className="mono wrap">{r.wallet}</th>
                    <td className="mono">{r.twab.toString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {check.offList.length > MOST_OFF_LIST && <p className="hint">… and {check.offList.length - MOST_OFF_LIST} more.</p>}
        </>
      )}
    </>
  );
}
