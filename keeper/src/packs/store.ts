import { type PackKey, keyString } from "./provider.js";

export type PackStatus = "planned" | "submitted" | "confirmed" | "pulled" | "failed";

/** One pack as the buyer sees it. Mirrors a row of `packs`. */
export interface PackRow {
  key: PackKey;
  status: PackStatus;
  /** How many purchases were started for this pack. */
  attempt: number;
  /** Signature of the current attempt (`submitted`, `confirmed`, `pulled`, and a `failed` pack's last one). */
  signature?: string;
  expiry?: string;
  price?: bigint;
  cardMint?: string;
  proofRef?: string;
  /** The latest thing that went wrong, for the operator. */
  lastError?: string;
}

export type AttemptOutcome = "submitted" | "confirmed" | "failed" | "expired";

/** Every signature ever submitted for a pack. */
export interface AttemptRow {
  attempt: number;
  signature: string;
  expiry: string;
  /** Undefined for a purchase that was found in wallet history. */
  price?: bigint;
  outcome: AttemptOutcome;
}

export interface NewAttempt {
  signature: string;
  expiry: string;
  price?: bigint;
}

export interface Reveal {
  cardMint: string;
  proofRef?: string;
  price?: bigint;
}

/**
 * Where the buyer keeps its notes. Every change of state is a compare-and-set that returns false when
 * another worker already moved the pack, so two buyers can never both start a purchase for one index.
 * `startAttempt` must be durable BEFORE the purchase is sent: that is what makes a crash safe.
 */
export interface PackStore {
  /** Inserts a `planned` pack unless one exists, and returns the pack either way. */
  ensure(key: PackKey): Promise<PackRow>;
  get(key: PackKey): Promise<PackRow | undefined>;
  listForBreak(breakId: string): Promise<PackRow[]>;

  /** planned → submitted: records a new attempt. False if the pack is no longer `planned`. */
  startAttempt(key: PackKey, attempt: NewAttempt): Promise<boolean>;

  /**
   * submitted → (confirmed | planned | failed), only if the pack is still waiting on `signature`.
   * `confirmed` keeps the signature; a retry (`planned`) clears it; `failed` gives the pack up.
   */
  resolveAttempt(
    key: PackKey,
    signature: string,
    outcome: { to: "confirmed" } | { to: "planned" | "failed"; why: "failed" | "expired"; reason: string },
  ): Promise<boolean>;

  /** confirmed → pulled. False if the pack is not `confirmed`. Throws if the card is already assigned to another pack. */
  complete(key: PackKey, reveal: Reveal): Promise<boolean>;

  /** Sets (or with null clears) the operator-facing note on a pack, in any state. */
  setError(key: PackKey, message: string | null): Promise<void>;

  attempts(key: PackKey): Promise<AttemptRow[]>;
}

/** In-memory store for tests and devnet runs. Same rules as the SQL one (see the shared contract test). */
export class MemoryPackStore implements PackStore {
  private readonly packs = new Map<string, PackRow>();
  private readonly log = new Map<string, AttemptRow[]>();
  private readonly signatures = new Set<string>();
  private readonly cards = new Set<string>();

  async ensure(key: PackKey): Promise<PackRow> {
    const k = keyString(key);
    let row = this.packs.get(k);
    if (!row) {
      row = { key: { ...key }, status: "planned", attempt: 0 };
      this.packs.set(k, row);
    }
    return { ...row };
  }

  async get(key: PackKey): Promise<PackRow | undefined> {
    const row = this.packs.get(keyString(key));
    return row ? { ...row } : undefined;
  }

  async listForBreak(breakId: string): Promise<PackRow[]> {
    return [...this.packs.values()]
      .filter((r) => r.key.breakId === breakId)
      .sort((a, b) => a.key.index - b.key.index)
      .map((r) => ({ ...r }));
  }

  async startAttempt(key: PackKey, a: NewAttempt): Promise<boolean> {
    const row = this.packs.get(keyString(key));
    if (!row || row.status !== "planned") return false;
    row.status = "submitted";
    row.attempt += 1;
    row.signature = a.signature;
    row.expiry = a.expiry;
    row.price = a.price;
    delete row.lastError;
    // Like the SQL store: a signature that is already on record (a purchase adopted again) is not logged twice.
    if (!this.signatures.has(a.signature)) {
      this.signatures.add(a.signature);
      const list = this.log.get(keyString(key)) ?? [];
      list.push({ attempt: row.attempt, signature: a.signature, expiry: a.expiry, price: a.price, outcome: "submitted" });
      this.log.set(keyString(key), list);
    }
    return true;
  }

  async resolveAttempt(
    key: PackKey,
    signature: string,
    outcome: { to: "confirmed" } | { to: "planned" | "failed"; why: "failed" | "expired"; reason: string },
  ): Promise<boolean> {
    const row = this.packs.get(keyString(key));
    if (!row || row.status !== "submitted" || row.signature !== signature) return false;
    const entry = (this.log.get(keyString(key)) ?? []).find((e) => e.signature === signature);
    row.status = outcome.to;
    if (outcome.to === "confirmed") {
      if (entry) entry.outcome = "confirmed";
      delete row.lastError;
      return true;
    }
    if (entry) entry.outcome = outcome.why;
    row.lastError = outcome.reason;
    if (outcome.to === "planned") {
      delete row.signature;
      delete row.expiry;
      delete row.price;
    }
    return true;
  }

  async complete(key: PackKey, reveal: Reveal): Promise<boolean> {
    const row = this.packs.get(keyString(key));
    if (!row || row.status !== "confirmed") return false;
    if (this.cards.has(reveal.cardMint)) throw new Error(`card ${reveal.cardMint} is already assigned to another pack`);
    this.cards.add(reveal.cardMint);
    row.status = "pulled";
    row.cardMint = reveal.cardMint;
    if (reveal.proofRef !== undefined) row.proofRef = reveal.proofRef;
    if (reveal.price !== undefined) row.price = reveal.price;
    return true;
  }

  async setError(key: PackKey, message: string | null): Promise<void> {
    const row = this.packs.get(keyString(key));
    if (!row) return;
    if (message === null) delete row.lastError;
    else row.lastError = message;
  }

  async attempts(key: PackKey): Promise<AttemptRow[]> {
    return (this.log.get(keyString(key)) ?? []).map((a) => ({ ...a }));
  }
}
