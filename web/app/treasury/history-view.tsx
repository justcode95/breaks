// The treasury's history on the treasury page: every transaction that touched it, newest first, and whether they add up. Pure:
// it takes the pages `loadTreasuryHistory` read and draws them; nothing here reads or checks.

import { type Address, SYSTEM_PROGRAM } from "../../lib/chain/address";
import { explorerTxUrl } from "../../lib/chain/buy";
import type { Action, Call, HistoryPage, Movement, Split } from "../../lib/chain/treasury-history";
import { money, share, utcTime } from "../../lib/chain/view";
import { shortAddress } from "../../lib/wallet/wallets";

export type HistoryState =
  | { state: "loading" }
  | { state: "error"; message: string }
  /** `more`: reading older transactions, or why that failed. */
  | { state: "loaded"; pages: HistoryPage[]; more?: "loading" | { error: string } };

/** The most problems listed at the top; each row still shows its own. */
export const MAX_PROBLEMS = 20;

const pct = (s: Split) => `${share(BigInt(s.subsidyBps), 10_000n)} / ${share(BigInt(s.holderBps), 10_000n)}`;

/** "$22.50 of the subsidy bucket and $30 of the holder bucket". */
export function pair(subsidy: bigint, holder: bigint): string {
  const parts = [subsidy > 0n ? `${money(subsidy)} of the subsidy bucket` : "", holder > 0n ? `${money(holder)} of the holder bucket` : ""].filter(Boolean);
  return parts.length > 0 ? parts.join(" and ") : "nothing";
}

/** "+$70", "−$22.50", "—". */
export function signed(amount: bigint): string {
  if (amount === 0n) return "—";
  return amount > 0n ? `+${money(amount)}` : `−${money(-amount)}`;
}

const breakName = (call: Call) => (call.breakNumber !== undefined ? `break #${call.breakNumber}` : call.breakKey ? "a break" : undefined);

/** One action, in a sentence. */
export function actionText(a: Action, call: Call, ctx: { buyer?: Address; authority?: Address }): string {
  const name = breakName(call);
  switch (a.kind) {
    case "set-up":
      return `The treasury was set up, with new deposits split ${pct(a)}.`;
    case "deposit":
      return `Deposit of ${money(a.amount)} from ${shortAddress(a.depositor)}${call.caller ? `, through the program ${shortAddress(call.caller)}` : ""}.`;
    case "split":
      return `The split of new deposits was changed to ${pct(a)}.`;
    case "controller":
      if (a.controller === SYSTEM_PROGRAM) return "The controller was removed: nobody can reserve or pay out money until a new one is set.";
      return `${a.controller === ctx.authority ? "The breaks program" : shortAddress(a.controller)} was made the controller: only it can reserve, release and pay out money.`;
    case "reserve":
      return `Reserved ${pair(a.subsidy, a.holder)}${name ? ` for ${name}` : ""}${call.step === "create_break" ? ", when it was created" : ""}.`;
    case "release":
      if (call.step === "fund_purchases") return `Released ${pair(a.subsidy, a.holder)} that ${name ?? "the break"} did not need.`;
      if (call.step === "cancel_break" || call.step === "cancel_unfundable") {
        return `Released ${pair(a.subsidy, a.holder)}: ${name ?? "the break"} was cancelled${call.step === "cancel_unfundable" ? ", as it could not be funded" : ""}.`;
      }
      return `Released ${pair(a.subsidy, a.holder)}${name ? ` of ${name}` : ""}.`;
    case "pay": {
      const to = a.recipient === undefined ? `the account ${shortAddress(a.destination)}` : a.recipient === ctx.buyer ? "the buyer wallet" : shortAddress(a.recipient);
      return `Paid ${money(a.amount)} from the ${a.bucket} bucket to ${to}${name ? `, for the packs of ${name}` : ""}.`;
    }
  }
}

/** What a transaction did, one sentence per action and per amount sent straight to a vault. */
export function movementText(m: Movement, ctx: { buyer?: Address; authority?: Address }): string[] {
  const lines = m.calls.flatMap((call) => call.actions.map((a) => actionText(a, call, ctx)));
  for (const s of m.straight) {
    lines.push(s.bucket ? `${money(s.amount)} sent straight to the ${s.bucket} vault, outside a deposit (so it was not split).` : `${money(s.amount)} sent straight to the vaults, outside a deposit.`);
  }
  return lines.length > 0 ? lines : ["Named the treasury."];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Signature({ signature }: { signature: string }) {
  const url = explorerTxUrl(signature);
  const label = shortAddress(signature);
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" title={signature}>
      {label}
    </a>
  ) : (
    <code className="mono" title={signature}>
      {label}
    </code>
  );
}

export function HistoryCard({ view, showOlder, retry }: { view: HistoryState; showOlder: () => void; retry: () => void }) {
  return (
    <section className="card">
      <h2>Money in and out</h2>
      <p className="hint">
        Every transaction that touched the treasury, newest first, read from the chain (finalized). The amounts are what the network recorded in each vault before and after the transaction; what each one did is read
        from the treasury program's own instructions in it. A reservation moves no money: it sets part of a bucket aside for a break.
      </p>
      {view.state === "loading" && <p>Reading the treasury's transactions…</p>}
      {view.state === "error" && (
        <>
          <p className="problem">{view.message}</p>
          <div className="actions">
            <button type="button" onClick={retry}>Try again</button>
          </div>
        </>
      )}
      {view.state === "loaded" && <Loaded pages={view.pages} more={view.more} showOlder={showOlder} />}
    </section>
  );
}

function Loaded({ pages, more, showOlder }: { pages: HistoryPage[]; more?: "loading" | { error: string }; showOlder: () => void }) {
  const rows = pages.flatMap((p) => p.rows);
  const quiet = pages.reduce((n, p) => n + p.quiet, 0);
  const last = pages[pages.length - 1] as HistoryPage;
  const ctx = { ...(last.buyer ? { buyer: last.buyer } : {}), ...(last.authority ? { authority: last.authority } : {}) };
  const problems = pages.flatMap((p) => [...p.rows.flatMap((r) => r.problems), ...p.problems]);
  const read = rows.length + quiet;

  return (
    <>
      {problems.length > 0 ? (
        <div className="verdict bad" role="alert">
          Not everything adds up:
          <ul>
            {problems.slice(0, MAX_PROBLEMS).map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          {problems.length > MAX_PROBLEMS && <p>and {plural(problems.length - MAX_PROBLEMS, "more problem", "more problems")}, shown in the rows below.</p>}
        </div>
      ) : last.complete ? (
        <div className="verdict ok" role="status">
          Every transaction since the treasury was set up is listed, and together they lead to what the vaults hold and what is reserved now.
        </div>
      ) : (
        <div className="verdict ok" role="status">
          The {plural(read, "transaction", "transactions")} read so far {read === 1 ? "leads" : "lead"}, without a gap, to what the vaults hold now.
        </div>
      )}
      {last.ended && (
        <p className="hint">The node has no older transactions of the treasury, and the set-up is not among them: many nodes do not keep old history, so this list may stop short of the start.</p>
      )}

      {rows.length > 0 && (
        <div className="table-wrap" role="region" aria-label="The treasury's transactions" tabIndex={0}>
          <table className="roomy history">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">What</th>
                <th scope="col">Subsidy</th>
                <th scope="col">Holder</th>
                <th scope="col">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.signature}>
                  <td className="num">{utcTime(BigInt(m.time))}</td>
                  <td className="words">
                    {movementText(m, ctx).map((line, i) => (
                      <span key={i} className="block">
                        {line}
                      </span>
                    ))}
                    {m.problems.map((p, i) => (
                      <span key={`p${i}`} className="block problem">
                        {p}
                      </span>
                    ))}
                  </td>
                  <td className="num">{signed(m.change.subsidy)}</td>
                  <td className="num">{signed(m.change.holder)}</td>
                  <td className="num">
                    <Signature signature={m.signature} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {quiet > 0 && <p className="hint">{plural(quiet, "more transaction", "more transactions")} named the treasury and changed nothing in it; {quiet === 1 ? "it is" : "they are"} not listed.</p>}

      <p className="hint">
        A transaction that moved money and is missing from what the node gave breaks the chain of balances. One that moved none (a reservation, a release, a change of the split) is only caught once the
        history is read back to the set-up, where nothing can be reserved yet.
      </p>

      {more !== undefined && more !== "loading" && <p className="problem">{more.error}</p>}
      {last.cursor && (
        <div className="actions">
          <button type="button" className="secondary" onClick={showOlder} disabled={more === "loading"}>
            {more === "loading" ? "Reading older transactions…" : more ? "Try again" : "Show older"}
          </button>
        </div>
      )}
    </>
  );
}
