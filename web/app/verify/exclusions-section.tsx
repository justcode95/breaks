// The exclusion list a break's list was made with, for the verify page's result. Pure: it takes what `verifyDraw` worked out
// and draws it; nothing here reads or computes anything.

import { heldBy } from "../../lib/twab/exclusions";
import type { ExclusionsReport } from "../../lib/verify";

/** The most wallets of the list shown at once. */
export const MOST_EXCLUDED = 50;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function ExclusionsSection({ exclusions }: { exclusions: ExclusionsReport }) {
  if (!exclusions.ok) {
    return (
      <>
        <h3>The exclusion list</h3>
        <div className="verdict bad" role="alert">The exclusion list could not be read.</div>
        <ul>
          {exclusions.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </>
    );
  }
  const { check, list } = exclusions;
  const held = heldBy(exclusions.record);
  const verdict =
    check.problems.length > 0
      ? { tone: "bad", text: `${plural(check.problems.length, "thing", "things")} about the exclusion list ${check.problems.length === 1 ? "does" : "do"} not add up.` }
      : check.checked.record
        ? { tone: "ok", text: "It is the exclusion list the record was made with: every wallet the record leaves out on purpose is on it, with the same code, and no other." }
        : { tone: "ok", text: "The exclusion list reads as one." };
  const unchecked = [
    check.checked.record ? "" : "the record was not given (or could not be read), so it was not compared with it",
    check.checked.chain ? "" : "no inputs hash from the break's account was given, so it was not compared with the chain",
  ].filter(Boolean);

  return (
    <>
      <h3>The exclusion list</h3>
      <div className={`verdict ${verdict.tone}`} role={check.problems.length === 0 ? "status" : "alert"}>
        {verdict.text}
      </div>
      {check.problems.length > 0 && (
        <ul>
          {check.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {unchecked.length > 0 && <p className="hint">Not checked: {unchecked.join("; ")}.</p>}
      <p>
        {list.entries.length === 0
          ? "Nobody was left out on purpose."
          : `${plural(list.entries.length, "wallet was", "wallets were")} left out on purpose${check.checked.record ? `: ${check.held} held the token, ${check.notHeld} held none of it (only this list shows ${check.notHeld === 1 ? "that one" : "those"}).` : "."}`}
      </p>
      {list.entries.length > 0 && (
        <div className="scroll" role="region" aria-label="Every wallet left out on purpose" tabIndex={0}>
          <table>
            <caption>Left out on purpose, in the list's order</caption>
            <thead>
              <tr>
                <th scope="col">Wallet</th>
                <th scope="col">Code</th>
                {check.checked.record && <th scope="col">Held the token?</th>}
              </tr>
            </thead>
            <tbody>
              {list.entries.slice(0, MOST_EXCLUDED).map((e) => (
                <tr key={e.wallet}>
                  <th scope="row" className="mono wrap">{e.wallet}</th>
                  <td>{e.code}</td>
                  {check.checked.record && <td>{held(e.wallet) ? "Yes" : "No"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.entries.length > MOST_EXCLUDED && <p className="hint">… and {list.entries.length - MOST_EXCLUDED} more.</p>}
      <p className="hint">Why a wallet is on this list is the keeper's word: the chain commits to none of it.</p>
    </>
  );
}
