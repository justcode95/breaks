// The connected wallet's coin and what it gives over the sale that is on. Pure: it takes what `loadHolding` found, the newest
// breaks and the last list's minimum, and lays them out.

import type { SaleHistory } from "../../lib/chain/history";
import type { BreakRow } from "../../lib/chain/list";
import { type Holding, type SaleFloor, reaches, saleFloor, tokenAmount } from "../../lib/chain/holding";
import { utcTime } from "../../lib/chain/view";

export type HoldingState = { state: "loading" } | { state: "error"; message: string } | { state: "loaded"; holding: Holding };
/** The wallet's history in the sale that is on: being read, or what came of it. */
export type HistoryState = { state: "reading" } | { state: "done"; history: SaleHistory };

const tokens = (units: bigint, decimals: number) => `${tokenAmount(units, decimals)} ${units === 10n ** BigInt(decimals) ? "token" : "tokens"}`;

/** "46%", or "under 1%" when some of the sale is left but not a whole percent. */
function partLeft(left: bigint, length: bigint): string {
  const p = (left * 100n) / length;
  return p === 0n ? "under 1%" : `${p}%`;
}

/** What the tokens held now give over the sale that is on, in a sentence or two. */
export function saleText(sale: SaleFloor, h: Holding): string {
  const d = h.mint.decimals;
  switch (sale.kind) {
    case "none":
      return "No sale is on right now. A sale's average balance runs from its opening to its close, so tokens held through a whole sale count in full.";
    case "no-time":
      return `Break #${sale.number} is on sale, but the node could not say when these balances are from, so what they add to the sale's average is not shown.`;
    case "closed":
      return `The sale of break #${sale.number} closed at ${utcTime(sale.closesAt)}; its list is made from the balances over it.`;
    case "before":
      return h.total === 0n
        ? `The sale of break #${sale.number} opens at ${utcTime(sale.opensAt)} and closes at ${utcTime(sale.closesAt)}; tokens held over the whole sale count in full.`
        : `The sale of break #${sale.number} opens at ${utcTime(sale.opensAt)} and closes at ${utcTime(sale.closesAt)}. If these tokens stay in this wallet over the whole sale, its average balance over it will be at least ${tokens(sale.floor, d)}.`;
    case "on":
      return h.total === 0n
        ? `Break #${sale.number} is on sale until ${utcTime(sale.closesAt)}. This wallet holds none of the token now, so it adds nothing for the rest of the sale; what it held earlier in the sale still counts.`
        : `Break #${sale.number} is on sale until ${utcTime(sale.closesAt)}. If these tokens stay in this wallet until then, its average balance over the sale will be at least ${tokens(sale.floor, d)}: they count for the ${partLeft(sale.left, sale.length)} of the sale still to come, and what the wallet held earlier in the sale counts too.`;
  }
}

/**
 * The wallet's average over the sale that is on, from its history: so far, and over the whole sale if it holds what it holds now
 * until the close.
 */
export function averageText(sale: Extract<SaleFloor, { kind: "on" }>, h: Holding, a: { soFar: bigint | undefined; toClose: bigint }): string {
  const d = h.mint.decimals;
  const until = `Break #${sale.number} is on sale until ${utcTime(sale.closesAt)}.`;
  const rest =
    h.total === 0n
      ? `It holds none of the token now, so if that does not change, its average over the whole sale will be ${tokens(a.toClose, d)}.`
      : `If it holds what it holds now until then, its average over the whole sale will be ${tokens(a.toClose, d)}.`;
  if (a.soFar === undefined) return `${until} The sale has only just opened. ${rest}`;
  return `${until} This wallet's average balance over the sale so far is ${tokens(a.soFar, d)}. ${rest}`;
}

/** Why the average so far is not shown, when the history was not read. */
export function historyProblemText(history: Exclude<SaleHistory, { kind: "read" }>): string {
  switch (history.kind) {
    case "too-much":
      return `Its average so far is not worked out here: ${history.message}. Only the least it can reach is shown.`;
    case "unreadable":
      return `Its transactions in this sale could not be read (${history.message}), so only the least it can reach is shown.`;
    case "does-not-add-up":
      return `Its transactions in this sale, as the node gave them, do not add up (${history.message}), so they are not used: only the least it can reach is shown.`;
  }
}

/**
 * How the wallet's figure compares with what the last list asked for; nothing when there is nothing to compare. `average` is its
 * average over the whole sale from its history, if it was read; otherwise the floor is compared.
 */
export function minimumText(sale: SaleFloor, h: Holding, minimum: { number: number; minTwab: bigint } | undefined, average?: bigint): string | undefined {
  if (sale.kind !== "on" && sale.kind !== "before") return undefined;
  const figure = average ?? sale.floor;
  if (h.total === 0n && figure === 0n) return undefined;
  if (!minimum) return "The minimum average balance a list asks for is stated in each list's record; none could be read here, so it is not compared.";
  const asked = `the minimum the last list asked for (break #${minimum.number}: ${tokens(minimum.minTwab, h.mint.decimals)} on average)`;
  if (average !== undefined) return reaches(average, minimum.minTwab) ? `That is enough for ${asked}, if the next list asks the same.` : `That is below ${asked}.`;
  if (reaches(sale.floor, minimum.minTwab)) return `That is enough on its own for ${asked}, if the next list asks the same.`;
  return sale.kind === "on"
    ? `That alone is below ${asked}; what the wallet held earlier in this sale counts too.`
    : `That is below ${asked}.`;
}

/** The units the lists count in, against the whole tokens shown here. */
function unitsText(decimals: number): string {
  if (decimals === 0) return "The token has no smaller unit, so the lists below count in whole tokens too.";
  return `Amounts here are in whole tokens; the lists below count in the token's smallest units, ${tokenAmount(10n ** BigInt(decimals), 0)} to a token.`;
}

export function HoldingView({
  view,
  rows,
  minimum,
  history,
  onRetry,
}: {
  view: HoldingState;
  rows: readonly BreakRow[];
  minimum?: { number: number; minTwab: bigint } | undefined;
  /** The wallet's history in the sale that is on, when one is on. */
  history?: HistoryState | undefined;
  onRetry?: () => void;
}) {
  return (
    <section className="card">
      <h2>This wallet's tokens</h2>
      {view.state === "loading" && <p>Reading this wallet's tokens…</p>}
      {view.state === "error" && <p className="problem">{view.message}</p>}
      {view.state === "loaded" && <HoldingBody h={view.holding} rows={rows} minimum={minimum} history={history} />}
      {view.state !== "loading" && onRetry && (
        <div className="actions">
          <button type="button" className="secondary" onClick={onRetry}>Read the balance again</button>
        </div>
      )}
    </section>
  );
}

function HoldingBody({
  h,
  rows,
  minimum,
  history,
}: {
  h: Holding;
  rows: readonly BreakRow[];
  minimum: { number: number; minTwab: bigint } | undefined;
  history: HistoryState | undefined;
}) {
  const sale = saleFloor(rows, h.total, h.time);
  const done = sale.kind === "on" && history?.state === "done" ? history.history : undefined;
  const read = done?.kind === "read" ? done : undefined;
  const compared = minimumText(sale, h, minimum, read?.toClose);
  return (
    <>
      <p>
        {h.total === 0n ? (
          "This wallet holds none of the token."
        ) : (
          <>
            <strong className="num">{tokens(h.total, h.mint.decimals)}</strong>, in {h.accounts} token {h.accounts === 1 ? "account" : "accounts"}.
          </>
        )}
      </p>
      <p>{sale.kind === "on" && read ? averageText(sale, h, read) : saleText(sale, h)}</p>
      {sale.kind === "on" && history?.state === "reading" && <p>Reading this wallet's transactions of the token since the sale opened, for its average so far…</p>}
      {done && done.kind !== "read" && <p>{historyProblemText(done)}</p>}
      {compared && <p>{compared}</p>}
      <p className="hint">
        Read from the chain (finalized){h.time === null ? "" : ` as it stood at ${utcTime(BigInt(h.time))}`}. {unitsText(h.mint.decimals)}
      </p>
      {read && (
        <p className="hint">
          Worked out on this page from the wallet's own transactions of the token since the sale opened ({read.transactions}{" "}
          {read.transactions === 1 ? "transaction" : "transactions"}, {read.accounts} token {read.accounts === 1 ? "account" : "accounts"}), by the lists'
          rule: the area under its balance, divided by the sale's length. A history with a transaction missing does not add up and is not used. The
          list itself is made by the keeper after the close, and a wallet it leaves out on purpose is not on it whatever it holds.
        </p>
      )}
      {!read && (sale.kind === "on" || sale.kind === "before") && h.total > 0n && (
        <p className="hint">
          This is a floor, not a forecast: the keeper works each wallet's average out from every balance change during the sale, which this page
          does not read, and a wallet it leaves out on purpose is not on the list whatever it holds.
        </p>
      )}
    </>
  );
}
