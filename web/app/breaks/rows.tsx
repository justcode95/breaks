import Link from "next/link";
import type { BreakRow } from "../../lib/chain/list";
import { money, stageLabel, utcTime } from "../../lib/chain/view";

/** The breaks as a table, in the order given (newest first). */
export function BreakRows({ rows, now }: { rows: BreakRow[]; now: number }) {
  return (
    // On a narrow screen the table scrolls inside its box instead of widening the page.
    <div className="scroll" role="region" aria-label="Breaks, newest first" tabIndex={0}>
      <table>
        <caption>Newest first</caption>
        <thead>
          <tr>
            <th scope="col">Break</th>
            <th scope="col">Stage</th>
            <th scope="col">Paid spots sold</th>
            <th scope="col">Free spots</th>
            <th scope="col">Spot price</th>
            <th scope="col">Opened</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ number, break: b }) => (
            <tr key={number}>
              <th scope="row">
                <Link href={`/breaks/${number}`}>Break #{number}</Link>
              </th>
              <td>{stageLabel(b, now)}</td>
              <td>
                {b.spotsSold} of {b.paidSpots}
              </td>
              <td>{b.freeSpots}</td>
              <td>{money(b.spotPrice)}</td>
              <td>{utcTime(b.opensAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One line about the newest break, for the home page. */
export function LatestSummary({ latest, total, now }: { latest: BreakRow | undefined; total: number; now: number }) {
  if (!latest) return <p>No break has been made yet. The first one opens by itself when the reserve can pay for it.</p>;
  const b = latest.break;
  return (
    <p>
      <Link href={`/breaks/${latest.number}`}>Break #{latest.number}</Link>: <strong>{stageLabel(b, now)}</strong>. {b.spotsSold} of {b.paidSpots} paid spots sold at {money(b.spotPrice)}, plus {b.freeSpots} free{" "}
      {b.freeSpots === 1 ? "spot" : "spots"} for holders.{" "}
      {total > 1 && <Link href="/breaks">All {total} breaks</Link>}
    </p>
  );
}
