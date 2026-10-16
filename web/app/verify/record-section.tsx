// Why each wallet is in or out, from the keeper's record, for the verify page's result. Pure: it takes what `verifyDraw`
// worked out and draws it; nothing here reads or computes anything.

import type { Reason } from "../../lib/twab/record";
import type { RecordReport } from "../../lib/verify";

/** The most wallets that are out shown at once: a token can have thousands of small holders. */
export const MOST_OUT = 50;

/** A reason in words. An exclusion's code is the keeper's own word and is shown as it is (React escapes it). */
export function reasonText(reason: Reason, minTwab: bigint): string {
  switch (reason.kind) {
    case "listed":
      return "on the list";
    case "below-min":
      return `below the minimum of ${minTwab}`;
    case "off-curve":
      return "a program's account (off the curve), never a holder";
    case "excluded":
      return `left out on purpose: ${reason.code}`;
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function RecordSection({ record }: { record: RecordReport }) {
  if (!record.ok) {
    return (
      <>
        <h3>Why each wallet is in or out</h3>
        <div className="verdict bad" role="alert">The record could not be read.</div>
        <ul>
          {record.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </>
    );
  }
  const { check } = record;
  const { policy } = record.record;
  const unchecked = [
    check.checked.twabs ? "" : "the balance events were not given, so the average balances in it were not worked out again",
    check.checked.list ? "" : "the eligibility list was not given, so it was not compared with the list",
    check.checked.chain ? "" : "no values from the break's account were given, so it was not compared with the chain",
  ].filter(Boolean);
  const verdict =
    check.problems.length === 0
      ? { tone: "ok", text: "Every wallet's reason follows from the rules the record states." }
      : { tone: "bad", text: `${plural(check.problems.length, "thing", "things")} in the record ${check.problems.length === 1 ? "does" : "do"} not add up.` };
  const { counts } = check;

  return (
    <>
      <h3>Why each wallet is in or out</h3>
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

      <dl>
        <dt>Minimum average balance</dt>
        <dd className="mono">{policy.minTwab.toString()}</dd>
        <dt>Most weight one wallet can have</dt>
        <dd>{policy.cap === undefined ? "No cap: a wallet's weight is its average balance." : <span className="mono">{policy.cap.toString()}</span>}</dd>
        <dt>Wallets</dt>
        <dd>
          {counts.listed} on the list, {counts.belowMin} below the minimum, {plural(counts.offCurve, "program's account", "programs' accounts")}, {counts.excluded} left out on purpose
        </dd>
      </dl>
      <p className="hint">
        The minimum, the cap and why a wallet is left out on purpose are the keeper's word: the chain commits to none of them. Everything else here is
        checked against them.
      </p>

      {check.out.length > 0 && (
        <div className="scroll" role="region" aria-label="Wallets that are not on the list, and why" tabIndex={0}>
          <table>
            <caption>Not on the list, biggest average balance first</caption>
            <thead>
              <tr>
                <th scope="col">Wallet</th>
                <th scope="col">Average balance</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {check.out.slice(0, MOST_OUT).map((r) => (
                <tr key={r.wallet}>
                  <th scope="row" className="mono wrap">{r.wallet}</th>
                  <td className="mono">{r.twab.toString()}</td>
                  <td>{reasonText(r.reason, policy.minTwab)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {check.out.length > MOST_OUT && <p className="hint">… and {check.out.length - MOST_OUT} more.</p>}
    </>
  );
}
