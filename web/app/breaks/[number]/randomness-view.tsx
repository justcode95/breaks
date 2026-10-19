// Where a break's randomness came from, on its page. Pure: it takes what `loadRandomness` found and draws it.

import type { BreakAccount } from "../../../lib/chain/accounts";
import { MAX_RANDOMNESS_ATTEMPTS, type RandomnessView } from "../../../lib/chain/randomness";
import { toHex } from "../../../lib/draw/bytes";

export type RandomnessViewState = RandomnessView | { kind: "loading" };

export function RandomnessSection({ view, b, onRetry }: { view: RandomnessViewState; b: BreakAccount; onRetry?: () => void }) {
  if (view.kind === "not-yet") return null;
  return (
    <section className="card">
      <h2>Randomness</h2>
      <p className="hint">
        The draw seed comes from ORAO, a separate randomness service. The program asks for it only after the eligible wallets and the
        cards are fixed on chain, with a request that commits to both.
      </p>
      <RandomnessBody view={view} b={b} {...(onRetry ? { onRetry } : {})} />
    </section>
  );
}

function RandomnessBody({ view, b, onRetry }: { view: Exclude<RandomnessViewState, { kind: "not-yet" }>; b: BreakAccount; onRetry?: () => void }) {
  if (view.kind === "loading") return <p>Reading the randomness request…</p>;
  if (view.kind === "unavailable") {
    return (
      <>
        <p>It could not be read ({view.message}).</p>
        {onRetry && (
          <div className="actions">
            <button type="button" className="secondary" onClick={onRetry}>Read it again</button>
          </div>
        )}
      </>
    );
  }
  const { check } = view;
  const answered = check.request.state === "fulfilled";
  const seeded = b.status === "Settled" || b.status === "Drawn";
  const verdict =
    check.problems.length > 0
      ? undefined
      : seeded
        ? "ORAO answered the request this break made, and the draw seed is worked out from that answer."
        : answered
          ? "ORAO has answered. The seed is stored when someone settles the request; anyone can."
          : "Randomness was asked of ORAO; its answer has not come yet.";
  return (
    <>
      {verdict ? (
        <div className="verdict ok" role="status">{verdict}</div>
      ) : (
        <>
          <div className="verdict bad" role="alert">The randomness of this break does not add up.</div>
          <ul>
            {check.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </>
      )}
      <dl>
        <dt>Request</dt>
        <dd>
          <code className="mono wrap">{toHex(check.requestId)}</code>
          <span className="hint block">
            SHA-256 of "breaks:randomness:v1", this break, the attempt, the eligibility root and the pool hash: it could not be known before
            both were committed.
          </span>
        </dd>
        <dt>Attempt</dt>
        <dd>
          {b.randomnessAttempt} of at most {MAX_RANDOMNESS_ATTEMPTS}
          {b.randomnessAttempt > 1 && <span className="hint block">An earlier request got no answer in time, so it was asked again.</span>}
        </dd>
        <dt>Randomness program</dt>
        <dd><code className="mono wrap">{check.vrfProgram}</code></dd>
        <dt>Request account</dt>
        <dd><code className="mono wrap">{check.requestAddress}</code></dd>
        {check.request.state === "fulfilled" && (
          <>
            <dt>ORAO's answer</dt>
            <dd><code className="mono wrap">{toHex(check.request.randomness)}</code></dd>
          </>
        )}
        {seeded && answered && check.problems.length === 0 && (
          <>
            <dt>Draw seed</dt>
            <dd>
              <code className="mono wrap">{toHex(b.seed)}</code>
              <span className="hint block">SHA-256 of "breaks:seed:v1" and ORAO's answer, as the program stored it.</span>
            </dd>
          </>
        )}
      </dl>
      <p className="hint">
        What stays ORAO's word is the answer itself: its request account keeps only the combined 64 bytes, not each oracle's signature,
        so this page cannot check them against ORAO's keys. The program takes what ORAO's own program wrote.
      </p>
    </>
  );
}
