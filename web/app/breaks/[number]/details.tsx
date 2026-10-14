import Link from "next/link";
import type { ReactNode } from "react";
import { breakAddress } from "../../../lib/chain/address";
import type { Loaded } from "../../../lib/chain/load";
import { duration, expectedWinners, machineLabel, money, percent, share, spotSlots, stageLabel, steps, tone, utcTime } from "../../../lib/chain/view";
import { toHex } from "../../../lib/draw/bytes";
import { SpotSlots } from "../slots";

export type { Loaded };

function Hex({ bytes }: { bytes: Uint8Array }) {
  return <code className="mono wrap">{toHex(bytes)}</code>;
}

const ZERO = (bytes: Uint8Array) => bytes.every((b) => b === 0);

/** `buy` is the place for the buy card, which needs a wallet and so is not part of this pure page. */
export function BreakDetails({ loaded, now, readAt, program, refresh, buy }: { loaded: Loaded; now: number; readAt: number; program: string; refresh: () => void; buy?: ReactNode }) {
  const b = loaded.break;
  const cancelled = b.status === "Cancelled";
  const list = steps(b, now);
  const committed = b.status !== "Open" && b.status !== "Closed" && !cancelled;
  const funded = ["Funded", "PoolCommitted", "RandomnessRequested", "Settled", "Drawn"].includes(b.status);
  const poolCommitted = ["PoolCommitted", "RandomnessRequested", "Settled", "Drawn"].includes(b.status);
  const seeded = b.status === "Settled" || b.status === "Drawn";
  const left = b.paidSpots - b.spotsSold;

  const open = b.status === "Open";
  const timeLeft = Number(b.closesAt) - now;
  const sale =
    cancelled
      ? { label: "Sale", value: "Cancelled", sub: undefined }
      : open && timeLeft > 0
        ? { label: "Closes in", value: duration(timeLeft), sub: utcTime(b.closesAt) }
        : open
          ? { label: "Sale", value: "Closing", sub: "waiting to be closed on chain" }
          : { label: "Sale", value: "Ended", sub: utcTime(b.closesAt) };

  return (
    <>
      <p className="lede">
        <span className={`badge ${tone(b, now)}`}>{stageLabel(b, now)}</span>{" "}
        {b.spotsSold} of {b.paidSpots} paid spots sold at {money(b.spotPrice)}, plus {b.freeSpots} free {b.freeSpots === 1 ? "spot" : "spots"} for holders.
        {open && left > 0 && ` ${left} paid ${left === 1 ? "spot" : "spots"} left.`}
      </p>

      <div className="stats">
        <div className="stat">
          <div className="label">Paid spots</div>
          <div className="value">{b.spotsSold} / {b.paidSpots}</div>
          <div className="bar" role="img" aria-label={`${b.spotsSold} of ${b.paidSpots} paid spots sold`}>
            <span style={{ width: `${percent(b.spotsSold, b.paidSpots)}%` }} />
          </div>
          {left > 0 && open ? <div className="sub">{left} left</div> : left <= 0 && <div className="sub">sold out</div>}
        </div>
        <div className="stat">
          <div className="label">Free spots</div>
          <div className="value">{b.freeSpots}</div>
          <div className="sub">for holders</div>
        </div>
        <div className="stat">
          <div className="label">Spot price</div>
          <div className="value">{money(b.spotPrice)}</div>
          <div className="sub">packs up to {money(b.maxPackPrice)}</div>
        </div>
        <div className="stat">
          <div className="label">{sale.label}</div>
          <div className="value">{sale.value}</div>
          {sale.sub && <div className="sub">{sale.sub}</div>}
        </div>
      </div>

      {buy}

      {!cancelled && spotSlots(b) && (
        <section className="card">
          <h2>The spots</h2>
          <SpotSlots b={b} />
        </section>
      )}

      <div className="cols">
        {cancelled ? (
          <section className="card">
            <h2>Cancelled</h2>
            <p>This break was cancelled: nothing was drawn, and the paid spots can be refunded.</p>
          </section>
        ) : (
          <section className="card">
            <h2>Progress</h2>
            <ol className="steps">
              {list.map((s) => (
                <li key={s.label} className={s.state} aria-current={s.state === "current" ? "step" : undefined}>
                  <span className="mark" aria-hidden="true">{s.state === "done" ? "✓" : s.state === "current" ? "●" : "○"}</span>
                  <span>
                    {s.label} <span className="sr-only">({s.state === "done" ? "done" : s.state === "current" ? "now" : "not yet"})</span>
                    {s.detail && <span className="hint block">{s.detail}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        <section className="card">
          <h2>The break</h2>
          <dl>
            <dt>Packs</dt>
            <dd>{machineLabel(b.packMachine)}, at most {money(b.maxPackPrice)} each. One pack is bought per spot.</dd>
            <dt>Window</dt>
            <dd>{utcTime(b.opensAt)} to {utcTime(b.closesAt)}</dd>
            {funded && (
              <>
                <dt>Pool</dt>
                <dd>{b.poolSize} {b.poolSize === 1 ? "pack" : "packs"}: the paid spots sold plus the free spots that have an eligible holder. An unsold paid spot is not bought.</dd>
              </>
            )}
            <dt>Break account</dt>
            <dd><code className="mono wrap">{breakAddress(program, b.id)}</code></dd>
          </dl>
        </section>
      </div>

      {committed && (
        <section className="card">
          <h2>Committed before the draw</h2>
          <p className="hint">These are fixed on chain before the randomness is requested, so nobody can prepare for the seed.</p>
          <dl>
            <dt>Eligible wallets</dt>
            <dd>{b.eligibilityCount} · total weight {b.eligibilityTotalWeight.toString()}</dd>
            <dt>Eligibility root</dt>
            <dd><Hex bytes={b.eligibilityRoot} /></dd>
            {poolCommitted && (
              <>
                <dt>Pool hash</dt>
                <dd><Hex bytes={b.poolHash} /></dd>
              </>
            )}
            {seeded && !ZERO(b.seed) && (
              <>
                <dt>Draw seed</dt>
                <dd><Hex bytes={b.seed} /></dd>
              </>
            )}
          </dl>
        </section>
      )}

      {b.freeSpots > 0 && !cancelled && (
        <section className="card">
          <h2>Free spots</h2>
          <p className="hint">
            Free spots go to eligible holders, drawn without replacement and in proportion to each wallet's weight in the committed list.
            {b.freeWinnerCount < expectedWinners(b) && seeded ? " The winners are being recorded one at a time." : ""}
          </p>
          {b.freeWinners.length > 0 ? (
            <div className="table-wrap" role="region" aria-label="Free-spot winners" tabIndex={0}>
              <table className="roomy">
                <caption>Winners recorded on chain, in draw order</caption>
                <thead>
                  <tr><th scope="col">#</th><th scope="col">Wallet</th><th scope="col">Weight</th><th scope="col">Share of the list</th></tr>
                </thead>
                <tbody>
                  {b.freeWinners.map((w, i) => (
                    <tr key={w.wallet}>
                      <td>{i + 1}</td>
                      <td><code className="mono wrap">{w.wallet}</code></td>
                      <td>{w.weight.toString()}</td>
                      <td>{share(w.weight, b.eligibilityTotalWeight)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No winners are recorded yet.</p>
          )}
        </section>
      )}

      {loaded.paidOwners.length > 0 && (
        <section className="card">
          <h2>Paid spots</h2>
          <div className="table-wrap" role="region" aria-label="Paid spots" tabIndex={0}>
            <table>
              <caption>In purchase order</caption>
              <thead>
                <tr><th scope="col">#</th><th scope="col">Wallet</th></tr>
              </thead>
              <tbody>
                {loaded.paidOwners.map((w, i) => (
                  // A wallet can buy several spots, so the position is the identity.
                  <tr key={`${i}-${w}`}>
                    <td>{i + 1}</td>
                    <td><code className="mono wrap">{w}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {loaded.notes.length > 0 && (
        <ul className="notes">
          {loaded.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      <div className="actions">
        <Link href={`/verify?break=${loaded.number}`} className="button">Check this draw yourself</Link>
        <button type="button" className="secondary" onClick={refresh}>Refresh</button>
      </div>
      <p className="hint">
        Read from the chain (finalized) {duration(Math.max(0, now - readAt))} ago{now - readAt >= 60 ? "; use Refresh to read it again" : ""}. Nothing here comes from a server of ours.
      </p>
    </>
  );
}
