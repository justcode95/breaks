import Link from "next/link";
import { type Mine, type MySpot, spotState } from "../../lib/chain/mine";
import { money, share, stageLabel, tone } from "../../lib/chain/view";

/**
 * What a wallet has in the breaks: the paid spots it bought and the free spots it won. Pure: the data comes in and the clicks go
 * out. With `onRefund`, a spot of a cancelled break that has not been refunded gets a button (disabled while `busy`, since one
 * refund runs at a time).
 */
export function MySpotsView({ mine, now, onRefund, busy = false }: { mine: Mine; now: number; onRefund?: (spot: MySpot) => void; busy?: boolean }) {
  const { spots, freeWins } = mine;
  const breaks = new Set(spots.map((s) => s.breakNumber)).size;
  const refundable = spots.filter((s) => !s.refunded && s.break.status === "Cancelled").length;
  return (
    <>
      <p>
        {spots.length === 0
          ? "This wallet has no paid spots in any break."
          : `This wallet has ${spots.length} paid ${spots.length === 1 ? "spot" : "spots"} in ${breaks} ${breaks === 1 ? "break" : "breaks"}.`}
        {freeWins.length > 0 && ` It won ${freeWins.length} free ${freeWins.length === 1 ? "spot" : "spots"}.`}
      </p>

      {spots.length > 0 && (
        <section className="card">
          <h2>Paid spots</h2>
          <div className="table-wrap" role="region" aria-label="Paid spots" tabIndex={0}>
            <table className="compact">
              <caption>Newest break first</caption>
              <thead>
                <tr>
                  <th scope="col">Break</th>
                  <th scope="col">Spot (paid)</th>
                  <th scope="col">Where it stands</th>
                </tr>
              </thead>
              <tbody>
                {spots.map((s) => {
                  const state = spotState(s, now);
                  return (
                    <tr key={`${s.breakNumber}-${s.index}`}>
                      <th scope="row">
                        <Link href={`/breaks/${s.breakNumber}`}>Break #{s.breakNumber}</Link>
                      </th>
                      <td className="num">
                        #{s.index + 1} ({money(s.paid)})
                      </td>
                      <td>
                        <span className={`badge ${state.tone}`}>{state.label}</span>
                        {onRefund && !s.refunded && s.break.status === "Cancelled" && (
                          <div>
                            <button type="button" className="secondary" disabled={busy} onClick={() => onRefund(s)} aria-label={`Refund spot #${s.index + 1} of break #${s.breakNumber}`}>
                              Refund {money(s.paid)}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {refundable > 0 && (
            <p className="hint">
              A cancelled break's spots are paid back to the wallet that bought them. Anyone can send the refund.{onRefund ? " Use the button to send yours." : " This site cannot send it yet."}
            </p>
          )}
          {mine.truncated && <p className="hint">Only the newest spots are shown.</p>}
        </section>
      )}

      {freeWins.length > 0 && (
        <section className="card">
          <h2>Free spots won</h2>
          <div className="table-wrap" role="region" aria-label="Free spots won" tabIndex={0}>
            <table className="compact">
              <caption>Newest break first</caption>
              <thead>
                <tr>
                  <th scope="col">Break</th>
                  <th scope="col">Place in the draw</th>
                  <th scope="col">Where it stands</th>
                </tr>
              </thead>
              <tbody>
                {freeWins.map((w) => (
                  <tr key={`${w.breakNumber}-${w.position}`}>
                    <th scope="row">
                      <Link href={`/breaks/${w.breakNumber}`}>Break #{w.breakNumber}</Link>
                    </th>
                    <td>
                      {w.position} of {w.break.freeSpots} ({share(w.weight, w.break.eligibilityTotalWeight)} of the list)
                    </td>
                    <td>
                      <span className={`badge ${tone(w.break, now)}`}>{stageLabel(w.break, now)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {mine.searched < mine.totalBreaks && (
        <p className="hint">
          Free spots are looked for in the newest {mine.searched} of {mine.totalBreaks} breaks.
        </p>
      )}
      <p className="hint">Cards and their delivery are not on chain, so they are not shown here.</p>
    </>
  );
}
