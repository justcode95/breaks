"use client";

import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { inputFromBreak, loadBreak } from "../../lib/chain/load";
import { emptyInput, exampleInput } from "../../lib/example";
import { NOT_PUBLISHED, type Provenance, applyLoad, loadPublishedLists } from "../../lib/published";
import { PUBLISHED_SETUP, SETUP } from "../../lib/site";
import { type VerifyInput, type VerifyResult, verifyDraw } from "../../lib/verify";
import { WeightsSection } from "./weights-section";

type Loading = { state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "loaded"; number: number; status: string; winners: number; notes: string[]; stillToPaste: string[] };

type Expected = VerifyInput["expected"];

function Field(props: { id: string; label: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <p className="hint" id={`${props.id}-hint`}>
        {props.hint}
      </p>
      {props.children}
    </div>
  );
}

export function VerifyForm() {
  // The form's text, and which fields hold text read from the published files (typing in one makes it the person's own).
  const [form, setForm] = useState<{ input: VerifyInput; provenance: Provenance }>({ input: emptyInput(), provenance: NOT_PUBLISHED });
  const input = form.input;
  const [result, setResult] = useState<VerifyResult | undefined>();
  const [number, setNumber] = useState("");
  const [loading, setLoading] = useState<Loading>({ state: "idle" });

  const set = (patch: Partial<VerifyInput>) =>
    setForm((f) => ({
      input: { ...f.input, ...patch },
      provenance: {
        holders: f.provenance.holders && patch.holders === undefined,
        inputs: f.provenance.inputs && patch.inputs === undefined,
        cards: f.provenance.cards && patch.cards === undefined,
      },
    }));
  const setExpected = (patch: Partial<Expected>) => setForm((f) => ({ ...f, input: { ...f.input, expected: { ...f.input.expected, ...patch } } }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setResult(verifyDraw(input));
  };
  const load = async (text: string = number) => {
    if (SETUP.kind !== "on") return;
    setLoading({ state: "loading" });
    setResult(undefined);
    try {
      const loaded = await loadBreak({ ...SETUP.config, number: Number(text.trim() === "" ? Number.NaN : text) });
      const { patch, onChain, notes } = inputFromBreak(loaded);
      // The eligibility list and the cards are not on chain: they are read from the published files when the site knows
      // where those are (each checked against the chain's commitment), and otherwise whatever was pasted stays.
      const published = await loadPublishedLists({ ...(PUBLISHED_SETUP.kind === "on" ? { baseUrl: PUBLISHED_SETUP.config.baseUrl } : {}), break: loaded.break });
      setForm((f) => applyLoad(f.input, f.provenance, { patch, onChain }, published));
      setLoading({ state: "loaded", number: loaded.number, status: loaded.break.status, winners: onChain.winners.length, notes: [...notes, ...published.notes], stillToPaste: published.stillToPaste });
    } catch (err) {
      setLoading({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };
  // A link such as /verify?break=3 (from a break's page) opens the form with that break loaded.
  useEffect(() => {
    const linked = new URLSearchParams(window.location.search).get("break");
    if (linked === null || !/^[1-9][0-9]{0,8}$/.test(linked)) return;
    setNumber(linked);
    void load(linked);
    // Once, when the page opens.
  }, []);
  const reset = (next: VerifyInput) => {
    setForm({ input: next, provenance: NOT_PUBLISHED });
    setResult(undefined);
    setLoading({ state: "idle" });
  };

  return (
    <>
      <form onSubmit={submit} noValidate>
        <fieldset>
          <legend>Load a break from the chain</legend>
          {SETUP.kind === "off" && <p className="hint">This site is not set up to read the chain yet, so paste the inputs below.</p>}
          {SETUP.kind === "problem" && <p className="hint" role="alert">The site's chain settings are wrong: {SETUP.problem}</p>}
          {SETUP.kind === "on" && (
            <>
              <p className="hint">
                Fills in the seed, the free spots, the paid spots' wallets, the values to compare with and the winners recorded on the break, read from the chain
                (finalized). Only the break number is sent to the node.{" "}
                {PUBLISHED_SETUP.kind === "on"
                  ? "The eligibility list, the balance events behind its weights and the cards are read from the published files and checked against the chain; if they cannot be read, paste them."
                  : "The eligibility list, the balance events and the cards are published off chain, so paste those yourself."}
              </p>
              <div className="inline">
                <label htmlFor="number">Break number</label>
                <input id="number" type="number" min={1} value={number} onChange={(e) => setNumber(e.target.value)} />
                <button type="button" onClick={() => void load()} disabled={loading.state === "loading"}>
                  {loading.state === "loading" ? "Loading…" : "Load from the chain"}
                </button>
              </div>
              <div aria-live="polite">
                {loading.state === "error" && <p className="problem">{loading.message}</p>}
                {loading.state === "loaded" && (
                  <>
                    <p>
                      Loaded break #{loading.number} ({loading.status}); {loading.winners} {loading.winners === 1 ? "winner is" : "winners are"} recorded on it.{loading.stillToPaste.length > 0 && ` Still to paste: ${loading.stillToPaste.join(" and ")}.`}
                    </p>
                    {loading.notes.length > 0 && (
                      <ul>
                        {loading.notes.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </fieldset>

        <div className="grid">
          <Field id="seed" label="Seed" hint="The draw seed on the break's account (64 hex digits), or ORAO's randomness for the request (128 hex digits); the seed is derived from it.">
            <input id="seed" className="mono" aria-describedby="seed-hint" value={input.seed} onChange={(e) => set({ seed: e.target.value })} spellCheck={false} autoComplete="off" />
          </Field>

          <Field id="free" label="Free spots" hint="How many free holder spots the break has (0 to 16). Fewer winners are drawn if fewer wallets are eligible.">
            <input id="free" type="number" min={0} max={16} aria-describedby="free-hint" value={input.freeSpots} onChange={(e) => set({ freeSpots: e.target.value })} />
          </Field>
        </div>

        <Field id="holders" label="Eligible holders" hint="The published eligibility list: one wallet and its weight per line, in any order. Lines starting with # are ignored.">
          <textarea id="holders" className="mono" rows={8} aria-describedby="holders-hint" value={input.holders} onChange={(e) => set({ holders: e.target.value })} spellCheck={false} />
        </Field>

        <Field
          id="inputs"
          label="Balance events (optional)"
          hint="The published record the weights were computed from: a first line starting breaks:inputs:v1, then one balance change per line, exactly as published. With it, every weight above is checked against the wallet's time-weighted average balance."
        >
          <textarea id="inputs" className="mono" rows={4} aria-describedby="inputs-hint" value={input.inputs} onChange={(e) => set({ inputs: e.target.value })} spellCheck={false} />
        </Field>

        <Field id="paid" label="Paid spots (optional)" hint="The buyer's wallet of each paid spot, one per line, in purchase order. Needed with the cards to see who gets which card.">
          <textarea id="paid" className="mono" rows={4} aria-describedby="paid-hint" value={input.paidOwners} onChange={(e) => set({ paidOwners: e.target.value })} spellCheck={false} />
        </Field>

        <Field id="cards" label="Cards in the pool (optional)" hint="The mint of every card that was pulled, one per line, in any order. There is one card per spot.">
          <textarea id="cards" className="mono" rows={4} aria-describedby="cards-hint" value={input.cards} onChange={(e) => set({ cards: e.target.value })} spellCheck={false} />
        </Field>

        <fieldset>
          <legend>Compare with the break's account (optional)</legend>
          <p className="hint">Copy these from the break's account on chain. A field you leave empty is not checked.</p>
          <div className="grid">
            <Field id="x-root" label="Eligibility root" hint="64 hex digits">
              <input id="x-root" className="mono" value={input.expected.root} onChange={(e) => setExpected({ root: e.target.value })} spellCheck={false} autoComplete="off" />
            </Field>
            <Field id="x-inputs" label="Balance-event hash" hint="64 hex digits">
              <input id="x-inputs" className="mono" value={input.expected.inputsHash} onChange={(e) => setExpected({ inputsHash: e.target.value })} spellCheck={false} autoComplete="off" />
            </Field>
            <Field id="x-pool" label="Pool hash" hint="64 hex digits">
              <input id="x-pool" className="mono" value={input.expected.poolHash} onChange={(e) => setExpected({ poolHash: e.target.value })} spellCheck={false} autoComplete="off" />
            </Field>
            <Field id="x-weight" label="Total weight" hint="a whole number">
              <input id="x-weight" className="mono" value={input.expected.totalWeight} onChange={(e) => setExpected({ totalWeight: e.target.value })} inputMode="numeric" autoComplete="off" />
            </Field>
            <Field id="x-count" label="Eligible wallets" hint="a whole number">
              <input id="x-count" className="mono" value={input.expected.entryCount} onChange={(e) => setExpected({ entryCount: e.target.value })} inputMode="numeric" autoComplete="off" />
            </Field>
          </div>
        </fieldset>

        <div className="actions">
          <button type="submit">Verify the draw</button>
          <button
            type="button"
            className="secondary"
            onClick={() => reset(exampleInput())}
          >
            Load an example
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => reset(emptyInput())}
          >
            Clear
          </button>
        </div>
      </form>

      <div aria-live="polite">{result && <Result result={result} />}</div>
    </>
  );
}

function Result({ result }: { result: VerifyResult }) {
  if (!result.ok) {
    return (
      <section className="result" role="alert">
        <h2>Cannot verify yet</h2>
        <ul>
          {result.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </section>
    );
  }
  const mismatch = result.checks.filter((c) => !c.matches);
  return (
    <section className="result" aria-labelledby="result-title">
      <h2 id="result-title">Result</h2>

      {result.checks.length > 0 && (
        <div className={mismatch.length === 0 ? "verdict ok" : "verdict bad"} role="status">
          {mismatch.length === 0
            ? `Every value you gave matches (${result.checks.length} checked).`
            : `${mismatch.length} of ${result.checks.length} values you gave do NOT match what these inputs produce.`}
        </div>
      )}

      {result.notes.length > 0 && (
        <ul className="notes">
          {result.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      <h3>Seed</h3>
      <p className="mono wrap">{result.seed.hex}</p>
      <p className="hint">{result.seed.derived ? "Derived from ORAO's randomness: sha256(\"breaks:seed:v1\" ‖ randomness)." : "Used as given."}</p>

      <h3>Eligibility commitment</h3>
      <dl>
        <dt>Root</dt>
        <dd className="mono wrap">{result.eligibility.root}</dd>
        <dt>Total weight</dt>
        <dd className="mono">{result.eligibility.totalWeight.toString()}</dd>
        <dt>Eligible wallets</dt>
        <dd className="mono">{result.eligibility.entries}</dd>
        {result.poolHash && (
          <>
            <dt>Pool hash</dt>
            <dd className="mono wrap">{result.poolHash}</dd>
          </>
        )}
      </dl>

      {result.weights && <WeightsSection weights={result.weights} />}

      {result.checks.length > 0 && (
        <div className="scroll" role="region" aria-label="Comparison with the break's account" tabIndex={0}>
          <table>
            <caption>Compared with the break's account</caption>
            <thead>
              <tr>
                <th scope="col">Value</th>
                <th scope="col">You gave</th>
                <th scope="col">These inputs give</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {result.checks.map((c) => (
                <tr key={c.label}>
                  <th scope="row">{c.label}</th>
                  <td className="mono wrap">{c.expected}</td>
                  <td className="mono wrap">{c.actual}</td>
                  <td>{c.matches ? "✓ matches" : "✗ differs"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Free-spot winners</h3>
      {result.winners.length === 0 ? (
        <p>No winners: there are no free spots or no eligible wallets.</p>
      ) : (
        <div className="scroll" role="region" aria-label="Free-spot winners" tabIndex={0}>
          <table>
            <caption>Drawn one after the other, without replacement</caption>
            <thead>
              <tr>
                <th scope="col">Draw</th>
                <th scope="col">Wallet</th>
                <th scope="col">Weight</th>
                <th scope="col">Range starts at</th>
                <th scope="col">Drawn position</th>
              </tr>
            </thead>
            <tbody>
              {result.winners.map((w) => (
                <tr key={w.wallet}>
                  <th scope="row">{w.draw}</th>
                  <td className="mono wrap">{w.wallet}</td>
                  <td className="mono">{w.weight.toString()}</td>
                  <td className="mono">{w.start.toString()}</td>
                  <td className="mono">{w.position.toString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result.assignment && (
        <>
          <h3>Who gets which card</h3>
          <div className="scroll" role="region" aria-label="Who gets which card" tabIndex={0}>
            <table>
              <caption>Paid spots in purchase order, then the free winners in draw order</caption>
              <thead>
                <tr>
                  <th scope="col">Spot</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Wallet</th>
                  <th scope="col">Card</th>
                </tr>
              </thead>
              <tbody>
                {result.assignment.map((s) => (
                  <tr key={s.spot}>
                    <th scope="row">{s.spot}</th>
                    <td>{s.kind}</td>
                    <td className="mono wrap">{s.wallet}</td>
                    <td className="mono wrap">{s.card}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
