import type { Address } from "../solana/pubkey.js";
import type { Delivery, SpotRef } from "./plan.js";

export type DeliveryStatus = "pending" | "submitted" | "confirmed" | "failed";

export interface DeliveryKey {
  breakId: string;
  spot: SpotRef;
}

export const keyString = (k: DeliveryKey): string => `${k.breakId}:${k.spot.kind}:${k.spot.idx}`;

/** One delivery as the deliverer sees it. Mirrors a row of `deliveries`. */
export interface DeliveryRow {
  key: DeliveryKey;
  recipient: Address;
  cardMint: Address;
  status: DeliveryStatus;
  attempt: number;
  /** Signature of the current attempt (`submitted`, `confirmed`; a `failed` delivery's last one). */
  signature?: string;
  expiry?: string;
  /** Found already delivered when the deliverer first looked: no transaction of ours. */
  adopted: boolean;
  /** The latest thing that went wrong, for the operator. */
  lastError?: string;
}

export type AttemptOutcome = "submitted" | "confirmed" | "failed" | "expired";

export interface AttemptRow {
  attempt: number;
  signature: string;
  expiry: string;
  outcome: AttemptOutcome;
}

/** The plan changed under us: the same spot is now meant to get a different card or go to a different wallet. */
export class PlanChangedError extends Error {
  constructor(key: DeliveryKey, detail: string) {
    super(`delivery ${keyString(key)} was planned differently before: ${detail}`);
    this.name = "PlanChangedError";
  }
}

/**
 * Where the deliverer keeps its notes. Every change of state is a compare-and-set that returns false when
 * another worker already moved the delivery. `startAttempt` must be durable BEFORE the transfer is sent.
 */
export interface DeliveryStore {
  /** Inserts a `pending` delivery unless one exists. Throws `PlanChangedError` if the existing one differs. */
  ensure(breakId: string, delivery: Delivery): Promise<DeliveryRow>;
  get(key: DeliveryKey): Promise<DeliveryRow | undefined>;
  listForBreak(breakId: string): Promise<DeliveryRow[]>;

  /** pending → submitted with a new attempt. False if the delivery is no longer `pending`. */
  startAttempt(key: DeliveryKey, attempt: { signature: string; expiry: string }): Promise<boolean>;

  /**
   * submitted → (confirmed | pending | failed), only if the delivery is still waiting on `signature`.
   * A retry (`pending`) clears the signature; `failed` gives the delivery up.
   */
  resolveAttempt(
    key: DeliveryKey,
    signature: string,
    outcome: { to: "confirmed" } | { to: "pending" | "failed"; why: "failed" | "expired"; reason: string },
  ): Promise<boolean>;

  /** pending → confirmed without a transaction of ours: the card was already at the recipient. */
  adopt(key: DeliveryKey): Promise<boolean>;

  /** pending → failed, for a delivery that must not be attempted (e.g. the card is in an unexpected wallet). */
  fail(key: DeliveryKey, reason: string): Promise<boolean>;

  setError(key: DeliveryKey, message: string | null): Promise<void>;
  attempts(key: DeliveryKey): Promise<AttemptRow[]>;
}

/** In-memory store for tests and devnet runs. Same rules as the SQL one (see the shared contract test). */
export class MemoryDeliveryStore implements DeliveryStore {
  private readonly rows = new Map<string, DeliveryRow>();
  private readonly log = new Map<string, AttemptRow[]>();
  private readonly signatures = new Set<string>();
  private readonly cards = new Set<string>();

  async ensure(breakId: string, d: Delivery): Promise<DeliveryRow> {
    const key: DeliveryKey = { breakId, spot: { ...d.spot } };
    const k = keyString(key);
    const existing = this.rows.get(k);
    if (existing) {
      if (existing.cardMint !== d.cardMint) throw new PlanChangedError(key, `card ${existing.cardMint} → ${d.cardMint}`);
      if (existing.recipient !== d.recipient) throw new PlanChangedError(key, `recipient ${existing.recipient} → ${d.recipient}`);
      return { ...existing, key: { ...existing.key } };
    }
    if (this.cards.has(d.cardMint)) throw new Error(`card ${d.cardMint} is already planned for another spot`);
    this.cards.add(d.cardMint);
    const row: DeliveryRow = { key, recipient: d.recipient, cardMint: d.cardMint, status: "pending", attempt: 0, adopted: false };
    this.rows.set(k, row);
    return { ...row };
  }

  async get(key: DeliveryKey): Promise<DeliveryRow | undefined> {
    const row = this.rows.get(keyString(key));
    return row ? { ...row } : undefined;
  }

  async listForBreak(breakId: string): Promise<DeliveryRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.key.breakId === breakId)
      .sort((a, b) => (a.key.spot.kind === b.key.spot.kind ? a.key.spot.idx - b.key.spot.idx : a.key.spot.kind === "paid" ? -1 : 1))
      .map((r) => ({ ...r }));
  }

  async startAttempt(key: DeliveryKey, a: { signature: string; expiry: string }): Promise<boolean> {
    const row = this.rows.get(keyString(key));
    if (!row || row.status !== "pending") return false;
    row.status = "submitted";
    row.attempt += 1;
    row.signature = a.signature;
    row.expiry = a.expiry;
    delete row.lastError;
    if (!this.signatures.has(a.signature)) {
      this.signatures.add(a.signature);
      const list = this.log.get(keyString(key)) ?? [];
      list.push({ attempt: row.attempt, signature: a.signature, expiry: a.expiry, outcome: "submitted" });
      this.log.set(keyString(key), list);
    }
    return true;
  }

  async resolveAttempt(
    key: DeliveryKey,
    signature: string,
    outcome: { to: "confirmed" } | { to: "pending" | "failed"; why: "failed" | "expired"; reason: string },
  ): Promise<boolean> {
    const row = this.rows.get(keyString(key));
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
    if (outcome.to === "pending") {
      delete row.signature;
      delete row.expiry;
    }
    return true;
  }

  async adopt(key: DeliveryKey): Promise<boolean> {
    const row = this.rows.get(keyString(key));
    if (!row || row.status !== "pending") return false;
    row.status = "confirmed";
    row.adopted = true;
    delete row.lastError;
    return true;
  }

  async fail(key: DeliveryKey, reason: string): Promise<boolean> {
    const row = this.rows.get(keyString(key));
    if (!row || row.status !== "pending") return false;
    row.status = "failed";
    row.lastError = reason;
    return true;
  }

  async setError(key: DeliveryKey, message: string | null): Promise<void> {
    const row = this.rows.get(keyString(key));
    if (!row) return;
    if (message === null) delete row.lastError;
    else row.lastError = message;
  }

  async attempts(key: DeliveryKey): Promise<AttemptRow[]> {
    return (this.log.get(keyString(key)) ?? []).map((a) => ({ ...a }));
  }
}
