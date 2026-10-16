import Link from "next/link";
import { share } from "../../lib/chain/view";
import type { BreakStanding, FreeSpot, Standing } from "../../lib/standing";

type Tone = "live" | "waiting" | "done" | "off";

/** Where the wallet stands on one break's list: a badge and a line. A code or a message is shown as text (React escapes it). */
export function standingText(s: BreakStanding, host: string): { badge: string; tone: Tone; line: string } {
  switch (s.kind) {
    case "not-yet":
      return s.break.status === "Open"
        ? { badge: "Sale on", tone: "live", line: "The list is made from the balances over the sale, after it ends." }
        : { badge: "List not made yet", tone: "waiting", line: "The sale is over; the list is made from the balances over it." };
    case "unavailable":
      return { badge: "Not known", tone: "waiting", line: unavailableText(s, host) };
    case "standing":
      return standingLine(s.standing, s.break.eligibilityTotalWeight, s.minTwab);
  }
}

function unavailableText(s: Extract<BreakStanding, { kind: "unavailable" }>, host: string): string {
  switch (s.why) {
    case "missing":
      return `The record of this break's list is not published at ${host} yet.`;
    case "unreachable":
      return `The record of this break's list could not be read from ${host} (${s.message}).`;
    case "invalid":
      return `The record at ${host} is not what the chain committed (${s.message}), so it was not used.`;
    case "problem":
      return `The record at ${host} does not add up (${s.message}), so it was not used.`;
  }
}

function standingLine(st: Standing, total: bigint, minTwab: bigint): { badge: string; tone: Tone; line: string } {
  switch (st.kind) {
    case "listed":
      return { badge: "On the list", tone: "done", line: `Average balance ${st.twab}, weight ${st.weight} (${share(st.weight, total)} of the list).` };
    case "absent":
      return { badge: "Not on the list", tone: "off", line: "This wallet held none of the token before the sale ended." };
    case "out":
      switch (st.reason.kind) {
        case "below-min":
          return { badge: "Not on the list", tone: "off", line: `Its average balance over the sale, ${st.twab}, is below the minimum of ${minTwab}.` };
        case "excluded":
          return { badge: "Not on the list", tone: "off", line: `Left out on purpose (${st.reason.code}); its average balance was ${st.twab}.` };
        case "off-curve":
          return { badge: "Not on the list", tone: "off", line: "It is a program's account (off the curve), which is never a holder." };
      }
  }
}

/** What the draw did or will do for a wallet on the list, in a few words. */
export function freeSpotText(free: FreeSpot, freeSpots: number): string {
  switch (free.kind) {
    case "won":
      return `Won: #${free.position} in the draw`;
    case "not-drawn":
      return "Not drawn";
    case "drawing":
      return "Being drawn";
    case "everyone":
      return `One for each wallet on the list (${freeSpots} free ${freeSpots === 1 ? "spot" : "spots"})`;
    case "later":
      return `${freeSpots} free ${freeSpots === 1 ? "spot" : "spots"}, drawn after the cards are pulled`;
  }
}

/**
 * Where the connected wallet stands on the free-spot lists of the newest breaks. Pure: the standings come in, a retry goes out
 * (offered when a record was missing or could not be reached, which may change on its own).
 */
export function StandingsView({ standings, host, onRetry }: { standings: readonly BreakStanding[]; host: string; onRetry?: () => void }) {
  const retry = standings.some((s) => s.kind === "unavailable" && (s.why === "missing" || s.why === "unreachable"));
  const cancellable = standings.some((s) => s.kind === "standing" && s.break.status === "EligibilityCommitted" && s.standing.kind === "listed");
  return (
    <section className="card">
      <h2>On the free-spot lists</h2>
      <p>
        Each break's free spots are drawn by weight from a list of holders, made from the balances over its sale.
        {standings.length === 1 && " This is where this wallet stands on the list of the newest break."}
        {standings.length > 1 && ` This is where this wallet stands on the lists of the newest ${standings.length} breaks.`} A cancelled break gives no free
        spots, so it is left out.
      </p>
      {standings.length === 0 ? (
        <p>There is no break to show yet.</p>
      ) : (
        <div className="table-wrap" role="region" aria-label="Where this wallet stands on the free-spot lists" tabIndex={0}>
          <table className="compact">
            <caption>Newest break first</caption>
            <thead>
              <tr>
                <th scope="col">Break</th>
                <th scope="col">On the list?</th>
                <th scope="col">Free spot</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((s) => {
                const t = standingText(s, host);
                return (
                  <tr key={s.number}>
                    <th scope="row">
                      <Link href={`/breaks/${s.number}`}>Break #{s.number}</Link>
                    </th>
                    <td>
                      <span className={`badge ${t.tone}`}>{t.badge}</span>
                      <div>{t.line}</div>
                      {s.kind === "unavailable" && (
                        <div>
                          <Link href={`/verify?break=${s.number}`}>Check this break on the verify page</Link>
                        </div>
                      )}
                    </td>
                    <td>{s.kind === "standing" && s.free ? freeSpotText(s.free, s.break.freeSpots) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {retry && onRetry && (
        <div className="actions">
          <button type="button" className="secondary" onClick={onRetry}>Read the lists again</button>
        </div>
      )}
      {cancellable && <p className="hint">A break can still be cancelled before its packs are paid for, and then nobody gets a free spot in it.</p>}
      {standings.some((s) => s.kind === "standing") && (
        <p className="hint">
          Average balances and weights are in the token's smallest units. Each record was read from {host} and used only if it states what the
          break's account commits and the wallets it puts on the list build the committed root, so whether this wallet is on a list, and with what
          weight, is the chain's word. Its average balance, and why a wallet is out, are the keeper's: the verify page checks them against the
          published balance events.
        </p>
      )}
    </section>
  );
}
