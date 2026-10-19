// The cards the connected wallet got, on My spots. Pure: it takes what `loadMyCards` found and draws it.

import Link from "next/link";
import { money } from "../../lib/chain/view";
import { type BreakCards, CARD_BREAKS, type MyCards } from "../../lib/my-cards";
import { Short, Tx } from "../breaks/[number]/ledger-view";

export type MyCardsState = { kind: "loading" } | { kind: "loaded"; cards: MyCards };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why a break's cards are not shown, in words. A message from the host or the node is text, never markup. */
export function notShownText(b: Exclude<BreakCards, { kind: "cards" }>, host: string): string {
  if (b.kind === "wrong") return `Its ledger at ${host} does not agree with the chain or the draw, so it is not used.`;
  switch (b.why) {
    case "missing":
      return `Its ledger is not published at ${host} yet. The keeper publishes it once every card of the break is delivered.`;
    case "unreachable":
      return `Its ledger could not be read or checked (${b.message}).`;
    case "invalid":
      return `The file at ${host} is not a ledger this page can use (${b.message}).`;
  }
}

export function MyCardsView({ state, host, onRetry }: { state: MyCardsState; host: string; onRetry?: () => void }) {
  return (
    <section className="card">
      <h2>Your cards</h2>
      {state.kind === "loading" ? <p>Reading the ledgers of the breaks you have spots in…</p> : <CardsBody cards={state.cards} host={host} {...(onRetry ? { onRetry } : {})} />}
    </section>
  );
}

function CardsBody({ cards, host, onRetry }: { cards: MyCards; host: string; onRetry?: () => void }) {
  if (cards.breaks.length === 0) return <p>No break you have a spot in has been drawn yet, so there are no cards to show.</p>;
  const rows = cards.breaks.flatMap((b) => (b.kind === "cards" ? b.cards.map((c) => ({ number: b.number, c })) : []));
  const notShown = cards.breaks.filter((b): b is Exclude<BreakCards, { kind: "cards" }> => b.kind !== "cards");
  const retry = notShown.some((b) => b.kind === "unavailable" && b.why !== "invalid");
  return (
    <>
      <p>
        {rows.length === 0 ? "No card can be shown yet." : `${plural(rows.length, "card", "cards")} from ${plural(new Set(rows.map((r) => r.number)).size, "break", "breaks")}.`}
        {cards.more > 0 && ` Only the newest ${CARD_BREAKS} drawn breaks you have a spot in are looked at; ${plural(cards.more, "older one is", "older ones are")} not.`}
      </p>
      {rows.length > 0 && (
        <div className="table-wrap" role="region" aria-label="Your cards" tabIndex={0}>
          <table className="compact">
            <caption>Newest break first</caption>
            <thead>
              <tr>
                <th scope="col">Break</th>
                <th scope="col">Card</th>
                <th scope="col">How it got to you</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ number, c }) => (
                <tr key={`${number}-${c.kind}-${c.index}`}>
                  <th scope="row">
                    <Link href={`/breaks/${number}`}>Break #{number}</Link>
                    <span className="block">{c.kind === "paid" ? "Paid" : "Free"} spot #{c.index + 1}</span>
                  </th>
                  <td>
                    <Short address={c.card} />
                    {c.pack && (
                      <span className="block">
                        from pack #{c.pack.index + 1}, <span className="num">{c.pack.price === undefined ? "price not known" : money(c.pack.price)}</span>
                      </span>
                    )}
                  </td>
                  <td>{c.deliveryTx === undefined ? "found at your wallet" : <Tx signature={c.deliveryTx} label="transfer" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {notShown.length > 0 && (
        <ul>
          {notShown.map((b) => (
            <li key={b.number}>
              <Link href={`/breaks/${b.number}`}>Break #{b.number}</Link>: {notShownText(b, host)}
            </li>
          ))}
        </ul>
      )}
      {retry && onRetry && (
        <div className="actions">
          <button type="button" className="secondary" onClick={onRetry}>Read the ledgers again</button>
        </div>
      )}
      <p className="hint">
        Cards are not on chain. Each break's ledger was read from {host} and used only if it agrees with the chain and the draw: its cards are the
        pool the break committed to, and each spot's card is the one the draw gives that spot. The transactions are the keeper's word: look them up.
        Whether a card can still be sold back, and until when, is not shown here yet.
      </p>
    </>
  );
}
