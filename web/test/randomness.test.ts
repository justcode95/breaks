import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RandomnessSection, type RandomnessViewState } from "../app/breaks/[number]/randomness-view";
import { type BreakAccount, decodeBreak } from "../lib/chain/accounts";
import { breakAddress, configAddress } from "../lib/chain/address";
import { type RandomnessView, checkRandomness, loadRandomness, parseRequest, requestAddress, requestId } from "../lib/chain/randomness";
import { concat, fromHex, toHex } from "../lib/draw/bytes";
import { seedFromRandomness } from "../lib/draw/draw";
import { type BreakFields, breakFieldsFromVector, configFieldsFromVector, encodeBreak, encodeConfig, fakeNode } from "./support/accounts";
import { buttons } from "./support/tree";

const ROOT = join(import.meta.dirname, "..", "..");
const vectors: { programs: { breaks: string }; cases: { name: string; inputs?: Record<string, any>; outputs?: Record<string, any> | null }[] } = JSON.parse(
  readFileSync(join(ROOT, "programs", "breaks", "instruction-vectors.json"), "utf8"),
);
const named = (n: string) => vectors.cases.find((c) => c.name === n) as { inputs: Record<string, any>; outputs: Record<string, any> };
const PROGRAM = vectors.programs.breaks;
const SAMPLE = breakFieldsFromVector(named("breaks.account.Break").outputs);
const CONFIG = configFieldsFromVector(named("breaks.account.BreaksConfig").outputs);
const VRF = CONFIG.randomnessProgram;
// Bytes of real ORAO request accounts (written by the real orao-solana-vrf crate), as the Rust program's tests pin them.
const rust = readFileSync(join(ROOT, "programs", "breaks", "src", "randomness.rs"), "utf8");
const constant = (name: string) => fromHex(new RegExp(`const ${name}: &str = "([0-9a-f]+)";`).exec(rust)?.[1] as string);
const REAL_FULFILLED = constant("REAL_FULFILLED");
const REAL_PENDING = constant("REAL_PENDING");
const ORAO = JSON.parse(readFileSync(join(ROOT, "keeper", "test", "fixtures", "orao.json"), "utf8")) as { vrfProgram: string; requestAddress: string; seed: string };

/** An ORAO request account as the real program lays it out (the same bytes as the Rust fixtures), padded to its 749 bytes. */
function requestAccount(seed: Uint8Array, answer?: Uint8Array): Uint8Array {
  const body = concat(Uint8Array.of(139, 239, 184, 215, 227, 86, 191, 226), Uint8Array.of(answer ? 1 : 0), new Uint8Array(32).fill(7), seed, answer ?? new Uint8Array(4));
  const out = new Uint8Array(749);
  out.set(body);
  return out;
}

const ANSWER = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256);
const brk = (over: Partial<BreakFields> = {}): BreakAccount => {
  const fields: BreakFields = { ...SAMPLE, id: 4n, status: "Drawn", randomnessAttempt: 1, ...over };
  const id = requestId(breakAddress(PROGRAM, fields.id), fields.randomnessAttempt, fields.eligibilityRoot, fields.poolHash);
  return decodeBreak(encodeBreak({ ...fields, randomnessRequestId: over.randomnessRequestId ?? id, seed: over.seed ?? seedFromRandomness(ANSWER) }));
};
const idOf = (b: BreakAccount) => requestId(breakAddress(PROGRAM, b.id), b.randomnessAttempt, b.eligibilityRoot, b.poolHash);

describe("the request and the seed, as the Rust program makes them", () => {
  it("reproduces the program's request id and draw seed", () => {
    const v = named("breaks.request_id");
    expect(toHex(requestId(v.inputs.break, v.inputs.attempt, fromHex(v.inputs.eligibilityRoot), fromHex(v.inputs.poolHash)))).toBe(v.outputs.requestId);
    const s = named("breaks.draw_seed");
    expect(toHex(seedFromRandomness(fromHex(s.inputs.answer)))).toBe(s.outputs.seed);
  });

  it("finds the request account where the real ORAO crate puts it", () => {
    expect(requestAddress(ORAO.vrfProgram, fromHex(ORAO.seed))).toBe(ORAO.requestAddress);
    expect(VRF).toBe(ORAO.vrfProgram);
  });

  it("refuses an attempt that is not a byte", () => {
    for (const a of [-1, 256, 1.5]) expect(() => requestId(PROGRAM, a, new Uint8Array(32), new Uint8Array(32)), String(a)).toThrow("the attempt is a byte");
  });
});

describe("reading ORAO's request account", () => {
  const SEED = new Uint8Array(32).fill(9);

  it("reads the real crate's pending and fulfilled accounts, at their own length and padded to 749 bytes", () => {
    expect(parseRequest(REAL_PENDING, SEED)).toEqual({ state: "pending" });
    const fulfilled = parseRequest(REAL_FULFILLED, SEED);
    expect(fulfilled).toEqual({ state: "fulfilled", randomness: Uint8Array.from({ length: 64 }, (_, i) => i) });
    expect(parseRequest(requestAccount(SEED), SEED)).toEqual({ state: "pending" });
    expect(parseRequest(requestAccount(SEED, Uint8Array.from({ length: 64 }, (_, i) => i)), SEED)).toEqual(fulfilled);
    // The test encoder writes the real crate's bytes.
    expect(toHex(requestAccount(SEED, Uint8Array.from({ length: 64 }, (_, i) => i)).subarray(0, REAL_FULFILLED.length))).toBe(toHex(REAL_FULFILLED));
  });

  it("refuses what is not a request for this seed, said in words", () => {
    expect(() => parseRequest(REAL_FULFILLED, new Uint8Array(32).fill(8))).toThrow("it is a request for another seed");
    const other = REAL_FULFILLED.slice();
    other[0] = 0;
    expect(() => parseRequest(other, SEED)).toThrow("it is not an ORAO randomness request");
    expect(() => parseRequest(REAL_PENDING.slice(0, 76), SEED)).toThrow("it is not an ORAO randomness request");
    expect(parseRequest(REAL_PENDING.slice(0, 77), SEED)).toEqual({ state: "pending" });
    expect(() => parseRequest(REAL_FULFILLED.slice(0, 136), SEED)).toThrow("its answer is cut short");
    expect(() => parseRequest(requestAccount(SEED, new Uint8Array(64)), SEED)).toThrow("its answer is blank");
    const odd = REAL_PENDING.slice();
    odd[8] = 2;
    expect(() => parseRequest(odd, SEED)).toThrow("it is in a state the program does not know (2)");
  });
});

describe("checking a break's randomness", () => {
  const fulfilled = (b: BreakAccount, answer = ANSWER) => ({ owner: VRF, data: requestAccount(idOf(b), answer) });

  it("finds nothing wrong with a drawn break whose seed comes from ORAO's answer to its own request", () => {
    const b = brk();
    const c = checkRandomness(b, PROGRAM, VRF, fulfilled(b));
    expect(c.problems).toEqual([]);
    expect(c.requestId).toEqual(b.randomnessRequestId);
    expect(c.requestAddress).toBe(requestAddress(VRF, idOf(b)));
    expect(c.request).toEqual({ state: "fulfilled", randomness: ANSWER });
    expect(c.vrfProgram).toBe(VRF);
  });

  it("checks a settled break's seed as it does a drawn one's", () => {
    const settled = brk({ status: "Settled" });
    expect(checkRandomness(settled, PROGRAM, VRF, fulfilled(settled)).problems).toEqual([]);
    const wrong = brk({ status: "Settled", seed: new Uint8Array(32).fill(2) });
    expect(checkRandomness(wrong, PROGRAM, VRF, fulfilled(wrong)).problems).toEqual([`the draw seed is ${"02".repeat(32)}, but SHA-256 of "breaks:seed:v1" and ORAO's answer is ${toHex(seedFromRandomness(ANSWER))}`]);
  });

  it("is happy with a request still waiting, or answered and not settled yet, while the break waits for it", () => {
    const b = brk({ status: "RandomnessRequested", seed: new Uint8Array(32) });
    expect(checkRandomness(b, PROGRAM, VRF, { owner: VRF, data: requestAccount(idOf(b)) })).toMatchObject({ problems: [], request: { state: "pending" } });
    expect(checkRandomness(b, PROGRAM, VRF, fulfilled(b))).toMatchObject({ problems: [], request: { state: "fulfilled" } });
  });

  it("says when the request id is not what the break's commitments give", () => {
    const b = brk({ randomnessRequestId: new Uint8Array(32).fill(1) });
    const p = checkRandomness(b, PROGRAM, VRF, fulfilled(b)).problems;
    expect(p).toEqual([`the break's request id is ${"01".repeat(32)}, but the break, its attempt, the eligibility root and the pool hash give ${toHex(idOf(b))}`]);
    // The request is looked for where the commitments say it is, not where the break's own id would put it.
    expect(checkRandomness(b, PROGRAM, VRF, fulfilled(b)).requestAddress).toBe(requestAddress(VRF, idOf(b)));
    // Each commitment is in the id: another attempt, root or pool hash gives another one.
    const ids = [brk(), brk({ randomnessAttempt: 2 }), brk({ eligibilityRoot: new Uint8Array(32).fill(4) }), brk({ poolHash: new Uint8Array(32).fill(4) }), brk({ id: 5n })].map((x) => toHex(idOf(x)));
    expect(new Set(ids).size).toBe(5);
  });

  it("says when the attempt is one the program never allows", () => {
    for (const randomnessAttempt of [0, 6]) {
      const b = brk({ randomnessAttempt });
      expect(checkRandomness(b, PROGRAM, VRF, fulfilled(b)).problems).toEqual([`the break says it asked ${randomnessAttempt} times, which the program never allows`]);
    }
    for (const randomnessAttempt of [1, 5]) {
      const b = brk({ randomnessAttempt });
      expect(checkRandomness(b, PROGRAM, VRF, fulfilled(b)).problems, String(randomnessAttempt)).toEqual([]);
    }
  });

  it("says when the request account is missing, not ORAO's, or not this request", () => {
    const b = brk();
    expect(checkRandomness(b, PROGRAM, VRF, null).problems).toEqual([`there is no request account at ${requestAddress(VRF, idOf(b))}`]);
    expect(checkRandomness(b, PROGRAM, VRF, { owner: PROGRAM, data: requestAccount(idOf(b), ANSWER) }).problems).toEqual([`the request account is not owned by the randomness program ${VRF}`]);
    expect(checkRandomness(b, PROGRAM, VRF, { owner: VRF, data: requestAccount(new Uint8Array(32).fill(3), ANSWER) }).problems).toEqual(["the request account cannot be read: it is a request for another seed"]);
  });

  it("says when the seed is not ORAO's answer, or there is a seed without one", () => {
    const b = brk({ seed: new Uint8Array(32).fill(2) });
    expect(checkRandomness(b, PROGRAM, VRF, fulfilled(b)).problems).toEqual([`the draw seed is ${"02".repeat(32)}, but SHA-256 of "breaks:seed:v1" and ORAO's answer is ${toHex(seedFromRandomness(ANSWER))}`]);
    const drawn = brk();
    expect(checkRandomness(drawn, PROGRAM, VRF, { owner: VRF, data: requestAccount(idOf(drawn)) }).problems).toEqual(["the break has a seed, but ORAO has not answered its request"]);
    const early = brk({ status: "RandomnessRequested" });
    expect(checkRandomness(early, PROGRAM, VRF, fulfilled(early)).problems).toEqual(["the break has a seed before its randomness is settled"]);
    // Another answer gives another seed.
    expect(checkRandomness(drawn, PROGRAM, VRF, fulfilled(drawn, ANSWER.map((x) => x ^ 1))).problems).toHaveLength(1);
  });
});

const RPC = "http://node.test";
function world(o: { config?: { data: Uint8Array; owner: string } | null; request?: Uint8Array | null; requestOwner?: string } = {}, b = brk()) {
  const accounts = new Map<string, { data: Uint8Array; owner: string }>();
  if (o.config !== null) accounts.set(configAddress(PROGRAM), o.config ?? { data: encodeConfig(CONFIG), owner: PROGRAM });
  if (o.request !== null) accounts.set(requestAddress(VRF, idOf(b)), { data: o.request ?? requestAccount(idOf(b), ANSWER), owner: o.requestOwner ?? VRF });
  return fakeNode(accounts);
}
const load = (node: ReturnType<typeof world>, b = brk()) => loadRandomness({ rpcUrl: RPC, breaksProgram: PROGRAM, break: b, fetch: node.fetchFn });

describe("loading a break's randomness", () => {
  it("reads the config, then the request it names, both at finalized, and checks them", async () => {
    const node = world();
    const v = await load(node);
    expect(v).toMatchObject({ kind: "checked", check: { problems: [], request: { state: "fulfilled" } } });
    expect(node.requests).toEqual([
      { addresses: [configAddress(PROGRAM)], config: { encoding: "base64", commitment: "finalized" } },
      { addresses: [requestAddress(VRF, idOf(brk()))], config: { encoding: "base64", commitment: "finalized" } },
    ]);
  });

  it("reads a request that is still waiting for ORAO", async () => {
    const waiting = brk({ status: "RandomnessRequested", seed: new Uint8Array(32) });
    const node = world({ request: requestAccount(idOf(waiting)) }, waiting);
    expect(await load(node, waiting)).toMatchObject({ kind: "checked", check: { problems: [], request: { state: "pending" } } });
    expect(node.requests).toHaveLength(2);
  });

  it("reads nothing before randomness is asked for, or for a cancelled break", async () => {
    for (const status of ["Open", "Closed", "EligibilityCommitted", "Funded", "PoolCommitted", "Cancelled"] as const) {
      const node = world();
      expect(await load(node, brk({ status })), status).toEqual({ kind: "not-yet" });
      expect(node.requests).toEqual([]);
    }
  });

  it("looks the request up under the randomness program the config names", async () => {
    const other = "11111111111111111111111111111111";
    const node = world({ config: { data: encodeConfig({ ...CONFIG, randomnessProgram: other }), owner: PROGRAM } });
    const v = (await load(node)) as Extract<RandomnessView, { kind: "checked" }>;
    expect(v.check.vrfProgram).toBe(other);
    expect(v.check.problems).toEqual([`there is no request account at ${requestAddress(other, idOf(brk()))}`]);
  });

  it("says when the config cannot be read", async () => {
    expect(await load(world({ config: null }))).toEqual({ kind: "unavailable", message: "the program's config account, which names the randomness program, is missing" });
    expect(await load(world({ config: { data: encodeConfig(CONFIG), owner: VRF } }))).toEqual({ kind: "unavailable", message: "the program's config account is not owned by the breaks program" });
    const failing = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    expect(await loadRandomness({ rpcUrl: RPC, breaksProgram: PROGRAM, break: brk(), fetch: failing })).toMatchObject({ kind: "unavailable", message: expect.stringContaining("network down") });
  });

  it("says when the request account is not there or not ORAO's", async () => {
    expect(await load(world({ request: null }))).toMatchObject({ kind: "checked", check: { problems: [expect.stringMatching(/^there is no request account at /)] } });
    expect(await load(world({ requestOwner: PROGRAM }))).toMatchObject({ kind: "checked", check: { problems: [`the request account is not owned by the randomness program ${VRF}`] } });
  });
});

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const render = (view: RandomnessViewState, b = brk()) => renderToStaticMarkup(createElement(RandomnessSection, { view, b }));
const checked = (b: BreakAccount, request: { owner: string; data: Uint8Array } | null): RandomnessViewState => ({ kind: "checked", check: checkRandomness(b, PROGRAM, VRF, request) });

describe("the randomness card on the break page", () => {
  it("is not there before randomness is asked for", () => {
    expect(render({ kind: "not-yet" })).toBe("");
  });

  it("shows the request, ORAO's answer and the seed of a drawn break, and what stays ORAO's word", () => {
    const b = brk();
    const t = text(render(checked(b, { owner: VRF, data: requestAccount(idOf(b), ANSWER) }), b));
    expect(t).toContain("Randomness");
    expect(t).toContain("ORAO answered the request this break made, and the draw seed is worked out from that answer.");
    expect(t).toContain(`Request ${toHex(idOf(b))} SHA-256 of "breaks:randomness:v1", this break, the attempt, the eligibility root and the pool hash`);
    expect(t).toContain("Attempt 1 of at most 5");
    expect(t).not.toContain("asked again");
    expect(t).toContain(`Randomness program ${VRF}`);
    expect(t).toContain(`Request account ${requestAddress(VRF, idOf(b))}`);
    expect(t).toContain(`ORAO's answer ${toHex(ANSWER)}`);
    expect(t).toContain(`Draw seed ${toHex(seedFromRandomness(ANSWER))}`);
    expect(t).toContain("so this page cannot check them against ORAO's keys");
  });

  it("says what a break waiting for its randomness is waiting for, and a repeated request", () => {
    const waiting = brk({ status: "RandomnessRequested", seed: new Uint8Array(32), randomnessAttempt: 2 });
    const pending = text(render(checked(waiting, { owner: VRF, data: requestAccount(idOf(waiting)) }), waiting));
    expect(pending).toContain("Randomness was asked of ORAO; its answer has not come yet.");
    expect(pending).toContain("Attempt 2 of at most 5 An earlier request got no answer in time, so it was asked again.");
    expect(pending).not.toContain("ORAO's answer");
    expect(pending).not.toContain("Draw seed");
    const answered = text(render(checked(waiting, { owner: VRF, data: requestAccount(idOf(waiting), ANSWER) }), waiting));
    expect(answered).toContain("ORAO has answered. The seed is stored when someone settles the request; anyone can.");
    expect(answered).toContain("ORAO's answer");
    expect(answered).not.toContain("Draw seed");
  });

  it("says what does not add up, as an alert, and never as markup", () => {
    const b = brk({ seed: new Uint8Array(32).fill(2) });
    const html = render(checked(b, { owner: VRF, data: requestAccount(idOf(b), ANSWER) }), b);
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("The randomness of this break does not add up.");
    expect(text(html)).toContain(`the draw seed is ${"02".repeat(32)}`);
    expect(text(html)).not.toContain("Draw seed 0202");
    const bad = renderToStaticMarkup(createElement(RandomnessSection, { view: { kind: "checked", check: { ...checkRandomness(b, PROGRAM, VRF, null), problems: ["<img src=x onerror=alert(1)>"] } }, b }));
    expect(bad).not.toContain("<img");
  });

  it("says when it could not be read, with a way to read it again, and while it reads", () => {
    const retry = vi.fn();
    const el = createElement(RandomnessSection, { view: { kind: "unavailable", message: "network down" }, b: brk(), onRetry: retry });
    expect(text(renderToStaticMarkup(el))).toContain("It could not be read (network down).");
    const [button] = buttons(el);
    expect(button?.text).toBe("Read it again");
    button?.onClick?.();
    expect(retry).toHaveBeenCalledOnce();
    expect(text(render({ kind: "loading" }))).toContain("Reading the randomness request…");
  });
});
