import { type BreakShape } from "../../lib/chain/reserve";
import { type BucketView, type Treasury, noController } from "../../lib/chain/treasury";
import { duration, money, share } from "../../lib/chain/view";
import { ReserveCard } from "../reserve-card";

/**
 * The treasury as the chain holds it: the buckets, who controls them and the addresses to check. With `shape` (what the next break
 * will be like), the reserve bar is shown first. Pure.
 */
export function TreasuryDetails({ treasury, program, now, readAt, refresh, shape }: { treasury: Treasury; program: string; now: number; readAt: number; refresh: () => void; shape?: BreakShape }) {
  const { config: c, subsidy, holder } = treasury;
  const rows: { name: string; pays: string; bps: number; bucket: BucketView }[] = [
    { name: "Subsidy", pays: "tops up the price of a paid spot when a spot costs less than a pack", bps: c.subsidyBps, bucket: subsidy },
    { name: "Holder", pays: "pays for the packs of the free holder spots", bps: c.holderBps, bucket: holder },
  ];
  const total = {
    balance: subsidy.balance + holder.balance,
    locked: subsidy.locked + holder.locked,
    available: subsidy.available + holder.available,
  };

  return (
    <>
      {shape && <ReserveCard shape={shape} treasury={treasury} />}

      <div className="stats wide">
        <div className="stat">
          <div className="label">Available for new breaks</div>
          <div className="value">{money(total.available)}</div>
          <div className="sub">can fund a break that is not made yet</div>
        </div>
        <div className="stat">
          <div className="label">Reserved for breaks</div>
          <div className="value">{money(total.locked)}</div>
          <div className="sub">already set aside for breaks that exist</div>
        </div>
        <div className="stat">
          <div className="label">In the vaults</div>
          <div className="value">{money(total.balance)}</div>
          <div className="sub">the whole treasury, in USDC</div>
        </div>
      </div>

      <h2>The two buckets</h2>
      <div className="scroll" role="region" aria-label="Treasury buckets" tabIndex={0}>
        <table>
          <caption>Every deposit is split between the buckets in these shares</caption>
          <thead>
            <tr>
              <th scope="col">Bucket</th>
              <th scope="col">Share of new deposits</th>
              <th scope="col">In the vault</th>
              <th scope="col">Reserved for breaks</th>
              <th scope="col">Available for new breaks</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <th scope="row">
                  {r.name}
                  <span className="hint block">{r.pays}</span>
                </th>
                <td>{share(BigInt(r.bps), 10_000n)}</td>
                <td className="num">{money(r.bucket.balance)}</td>
                <td className="num">{money(r.bucket.locked)}</td>
                <td className="num">{money(r.bucket.available)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td>{share(BigInt(c.subsidyBps + c.holderBps), 10_000n)}</td>
              <td className="num">{money(total.balance)}</td>
              <td className="num">{money(total.locked)}</td>
              <td className="num">{money(total.available)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <section className="card">
        <h2>How the money is used</h2>
        <ul>
          <li>A break is only created when the buckets can cover its worst case: every free spot at the highest pack price, and every paid spot's gap between that price and its own price.</li>
          <li>Creating a break reserves that amount. Pay-outs can only come out of reserved money, so they never touch the money reserved for another break.</li>
          <li>The treasury only holds USDC. Fees arrive as SOL and are swapped before they are deposited.</li>
        </ul>
      </section>

      <section className="card">
        <h2>Who controls it</h2>
        <dl>
          <dt>Admin</dt>
          <dd>
            <code className="mono wrap">{c.admin}</code>
            <span className="hint block">Changes the split and appoints the controller. Meant to be a multisig.</span>
          </dd>
          <dt>Controller</dt>
          <dd>
            {noController(c.controller) ? (
              <>
                <strong>Not set yet.</strong> Until the admin appoints one, nobody can reserve or pay out money.
              </>
            ) : (
              <>
                <code className="mono wrap">{c.controller}</code>
                <span className="hint block">The only signer that can reserve, release and pay out money. In production, the breaks program.</span>
              </>
            )}
          </dd>
          <dt>Money</dt>
          <dd>
            <code className="mono wrap">{c.usdcMint}</code>
            <span className="hint block">The USDC mint both buckets are held in.</span>
          </dd>
        </dl>

        <details>
          <summary>Addresses to check this yourself</summary>
          <dl>
            <dt>Treasury program</dt>
            <dd><code className="mono wrap">{program}</code></dd>
            <dt>Config</dt>
            <dd><code className="mono wrap">{treasury.configAddress}</code></dd>
            <dt>Subsidy vault</dt>
            <dd><code className="mono wrap">{subsidy.vault}</code></dd>
            <dt>Holder vault</dt>
            <dd><code className="mono wrap">{holder.vault}</code></dd>
          </dl>
        </details>
      </section>

      {treasury.notes.length > 0 && (
        <ul className="notes">
          {treasury.notes.map((n) => (
            <li key={n} className="problem">{n}</li>
          ))}
        </ul>
      )}

      <div className="actions">
        <button type="button" className="secondary" onClick={refresh}>Refresh</button>
      </div>
      <p className="hint">
        Read from the chain (finalized) {duration(Math.max(0, now - readAt))} ago{now - readAt >= 60 ? "; use Refresh to read it again" : ""}. Nothing here comes from a server of ours.
      </p>
    </>
  );
}
