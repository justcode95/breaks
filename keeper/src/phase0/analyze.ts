// Phase 0 helper: reads one real transaction (a pack purchase, a card transfer, a sellback) and states the facts that
// the pack buyer and the card delivery depend on, in a form that can be pasted back into a conversation:
//   which programs run, who has to sign, whether a memo is there or could be added, where the USDC goes, which token
//   (the card) arrives and in whose wallet, which accounts are created, and what the logs say.
// It only reads. It never sends anything and never holds a key.

export interface ParsedInstruction {
  program?: string;
  programId: string;
  parsed?: unknown;
  accounts?: string[];
  data?: string;
}

export interface TokenBalanceJson {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount?: number | null; uiAmountString?: string };
}

/** The `getTransaction` answer with `jsonParsed` encoding (the part this tool reads). */
export interface TransactionJson {
  slot: number;
  blockTime?: number | null;
  version?: number | "legacy";
  transaction: {
    signatures: string[];
    message: {
      accountKeys: { pubkey: string; signer: boolean; writable: boolean; source?: string }[];
      instructions: ParsedInstruction[];
      addressTableLookups?: unknown[] | null;
      recentBlockhash?: string;
    };
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalanceJson[] | null;
    postTokenBalances?: TokenBalanceJson[] | null;
    innerInstructions?: { index: number; instructions: ParsedInstruction[] }[] | null;
    logMessages?: string[] | null;
    computeUnitsConsumed?: number;
  } | null;
}

export interface InstructionLine {
  /** Position: `3` for the fourth top-level instruction, `3.1` for its second inner one. */
  at: string;
  program: string;
  programId: string;
  /** For parsed instructions: their type (`transfer`, `createAccount`, ...). */
  type?: string;
  /** The first bytes of the data of an instruction the node could not parse (an 8-byte discriminator for Anchor programs). */
  dataHead?: string;
  accounts?: number;
  memo?: string;
}

export interface TokenChange {
  tokenAccount: string;
  owner?: string;
  mint: string;
  before: bigint;
  after: bigint;
  decimals: number;
}

export interface TxReport {
  signature: string;
  ok: boolean;
  err?: unknown;
  slot: number;
  time?: string;
  version: string;
  feePayer: string;
  signers: string[];
  feeLamports: number;
  computeUnits?: number;
  usesLookupTables: boolean;
  /** Distinct programs in order of first use, top level and inner. */
  programs: { id: string; name: string }[];
  instructions: InstructionLine[];
  tokenChanges: TokenChange[];
  solChanges: { address: string; delta: bigint }[];
  createdAccounts: { address: string; owner?: string }[];
  memos: string[];
  logs: string[];
  notes: string[];
}

/** Programs whose ids are well known. Anything else is shown by id for the owner to look up. */
const KNOWN_PROGRAMS: Record<string, string> = {
  "11111111111111111111111111111111": "System",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d: "Metaplex Core",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex Token Metadata",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter v6",
};

/** Mainnet USDC. Payments in it are called out. */
export const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const BORING = new Set(["System", "SPL Token", "Token-2022", "Associated Token Account", "Compute Budget", "spl-memo"]);

const nameOf = (ix: ParsedInstruction): string => KNOWN_PROGRAMS[ix.programId] ?? ix.program ?? ix.programId;

/** Hex of the first `n` bytes of a base58 string, without a dependency: the alphabet is small. */
export function base58Head(data: string, n: number): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const ch of data) {
    const d = ALPHABET.indexOf(ch);
    if (d < 0) return "";
    value = value * 58n + BigInt(d);
  }
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const leadingZeros = data.length - data.replace(/^1+/, "").length;
  const bytes = "00".repeat(leadingZeros) + (value === 0n ? "" : hex);
  return bytes.slice(0, n * 2);
}

function line(at: string, ix: ParsedInstruction, memos: string[]): InstructionLine {
  const l: InstructionLine = { at, program: nameOf(ix), programId: ix.programId };
  if (ix.program === "spl-memo" && typeof ix.parsed === "string") {
    l.memo = ix.parsed;
    memos.push(ix.parsed);
  }
  const parsed = ix.parsed as { type?: string } | string | undefined;
  if (parsed && typeof parsed === "object" && typeof parsed.type === "string") l.type = parsed.type;
  if (ix.data !== undefined && ix.parsed === undefined) l.dataHead = base58Head(ix.data, 8);
  if (ix.accounts) l.accounts = ix.accounts.length;
  return l;
}

export function analyze(tx: TransactionJson): TxReport {
  const meta = tx.meta;
  if (!meta) throw new Error("the node returned no metadata for this transaction");
  const keys = tx.transaction.message.accountKeys;
  const signers = keys.filter((k) => k.signer).map((k) => k.pubkey);
  const feePayer = keys[0]?.pubkey ?? "";

  const memos: string[] = [];
  const instructions: InstructionLine[] = [];
  const programs = new Map<string, string>();
  const created = new Map<string, string | undefined>();
  const note = (ix: ParsedInstruction) => {
    if (!programs.has(ix.programId)) programs.set(ix.programId, nameOf(ix));
    const p = ix.parsed as { type?: string; info?: { newAccount?: string; owner?: string } } | undefined;
    if (ix.program === "system" && p && typeof p === "object" && (p.type === "createAccount" || p.type === "createAccountWithSeed") && p.info?.newAccount) {
      created.set(p.info.newAccount, p.info.owner);
    }
  };
  tx.transaction.message.instructions.forEach((ix, i) => {
    instructions.push(line(String(i), ix, memos));
    note(ix);
  });
  for (const inner of meta.innerInstructions ?? []) {
    inner.instructions.forEach((ix, j) => {
      instructions.push(line(`${inner.index}.${j}`, ix, memos));
      note(ix);
    });
  }
  instructions.sort((a, b) => compareAt(a.at, b.at));

  // Token balances: before and after, per token account.
  const side = (list: TokenBalanceJson[] | null | undefined) => new Map((list ?? []).map((b) => [b.accountIndex, b] as const));
  const pre = side(meta.preTokenBalances);
  const post = side(meta.postTokenBalances);
  const tokenChanges: TokenChange[] = [];
  for (const index of [...new Set([...pre.keys(), ...post.keys()])].sort((a, b) => a - b)) {
    const b = pre.get(index);
    const a = post.get(index);
    const before = BigInt(b?.uiTokenAmount.amount ?? "0");
    const after = BigInt(a?.uiTokenAmount.amount ?? "0");
    if (before === after) continue;
    const owner = a?.owner ?? b?.owner;
    tokenChanges.push({
      tokenAccount: keys[index]?.pubkey ?? `#${index}`,
      ...(owner !== undefined ? { owner } : {}),
      mint: (a ?? b)!.mint,
      before,
      after,
      decimals: (a ?? b)!.uiTokenAmount.decimals,
    });
  }

  const solChanges: { address: string; delta: bigint }[] = [];
  keys.forEach((k, i) => {
    const delta = BigInt(meta.postBalances[i] ?? 0) - BigInt(meta.preBalances[i] ?? 0);
    if (delta !== 0n) solChanges.push({ address: k.pubkey, delta });
  });
  // Accounts that did not exist before (no lamports) and do now.
  const createdAccounts: { address: string; owner?: string }[] = [];
  keys.forEach((k, i) => {
    if ((meta.preBalances[i] ?? 0) === 0 && (meta.postBalances[i] ?? 0) > 0) {
      const owner = created.get(k.pubkey);
      createdAccounts.push({ address: k.pubkey, ...(owner !== undefined ? { owner } : {}) });
    }
  });

  const report: TxReport = {
    signature: tx.transaction.signatures[0] ?? "",
    ok: meta.err === null || meta.err === undefined,
    ...(meta.err !== null && meta.err !== undefined ? { err: meta.err } : {}),
    slot: tx.slot,
    ...(tx.blockTime ? { time: new Date(tx.blockTime * 1000).toISOString() } : {}),
    version: String(tx.version ?? "legacy"),
    feePayer,
    signers,
    feeLamports: meta.fee,
    ...(meta.computeUnitsConsumed !== undefined ? { computeUnits: meta.computeUnitsConsumed } : {}),
    usesLookupTables: (tx.transaction.message.addressTableLookups?.length ?? 0) > 0,
    programs: [...programs].map(([id, name]) => ({ id, name })),
    instructions,
    tokenChanges,
    solChanges,
    createdAccounts,
    memos,
    logs: meta.logMessages ?? [],
    notes: [],
  };
  report.notes = observations(report);
  return report;
}

function compareAt(a: string, b: string): number {
  const [a0, a1] = a.split(".").map(Number) as [number, number | undefined];
  const [b0, b1] = b.split(".").map(Number) as [number, number | undefined];
  return a0 - b0 || (a1 ?? -1) - (b1 ?? -1);
}

/** What follows from the facts, in the terms of the open Phase 0 questions. */
function observations(r: TxReport): string[] {
  const notes: string[] = [];
  const others = r.signers.filter((s) => s !== r.feePayer);
  if (others.length === 0) {
    notes.push(`Only the fee payer (${r.feePayer}) signed. A transaction like this can be built and signed by our own code, so a memo can be added to it.`);
  } else {
    notes.push(`Signers besides the fee payer: ${others.join(", ")}. If one of them is Collector Crypt's (a co-signer), only their service can complete this transaction, and a memo cannot be added without invalidating their signature. Find out whose key each is.`);
  }
  notes.push(r.memos.length > 0 ? `A memo is present: ${r.memos.map((m) => JSON.stringify(m)).join(", ")}.` : "There is no memo in this transaction.");
  if (r.usesLookupTables) notes.push("The message uses address lookup tables (version 0), so building it needs those tables.");

  for (const t of r.tokenChanges) {
    const delta = t.after - t.before;
    if (t.mint === MAINNET_USDC) {
      notes.push(`USDC ${delta < 0n ? "left" : "arrived at"} token account ${t.tokenAccount}${t.owner ? ` (owner ${t.owner})` : ""}: ${formatUnits(delta < 0n ? -delta : delta, t.decimals)}.`);
    } else if (t.decimals === 0 && (t.after <= 1n && t.before <= 1n)) {
      notes.push(`A 1-of-1 token (mint ${t.mint}) ${delta > 0n ? "arrived at" : "left"} ${t.owner ?? t.tokenAccount}. It is probably the card; check what standard it is (see DAS getAsset).`);
    }
  }
  const coreAccounts = r.createdAccounts.filter((c) => c.owner === "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
  for (const c of coreAccounts) notes.push(`Account ${c.address} was created and is owned by Metaplex Core: the card is probably a Core asset.`);

  const unusual = r.programs.filter((p) => !BORING.has(p.name));
  if (unusual.length > 0) notes.push(`Programs beyond the basic ones (look these up and send me their ids): ${unusual.map((p) => `${p.name === p.id ? p.id : `${p.name} (${p.id})`}`).join(", ")}.`);
  if (!r.ok) notes.push(`The transaction FAILED: ${JSON.stringify(r.err)}.`);
  return notes;
}

const formatUnits = (amount: bigint, decimals: number): string => {
  const s = amount.toString().padStart(decimals + 1, "0");
  return decimals === 0 ? s : `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
};

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

/** The report as markdown. */
export function render(label: string, r: TxReport): string {
  const out: string[] = [];
  out.push(`## ${label}`, "", `- signature: \`${r.signature}\``, `- result: ${r.ok ? "success" : `FAILED ${JSON.stringify(r.err)}`}`);
  out.push(`- slot ${r.slot}${r.time ? `, ${r.time}` : ""}, version ${r.version}, fee ${r.feeLamports} lamports${r.computeUnits !== undefined ? `, ${r.computeUnits} compute units` : ""}`);
  out.push(`- fee payer: \`${r.feePayer}\``, `- signers: ${r.signers.map((s) => `\`${s}\``).join(", ")}`);
  out.push(`- programs: ${r.programs.map((p) => (p.name === p.id ? `\`${p.id}\`` : `${p.name} (\`${p.id}\`)`)).join(", ")}`, "");

  out.push("### Notes", "", ...r.notes.map((n) => `- ${n}`), "");

  out.push("### Instructions", "", "| at | program | type / data | accounts |", "|---|---|---|---|");
  for (const i of r.instructions) {
    const what = i.memo !== undefined ? `memo ${JSON.stringify(i.memo)}` : (i.type ?? (i.dataHead ? `data ${i.dataHead}…` : ""));
    out.push(`| ${i.at} | ${i.program === i.programId ? `\`${short(i.programId)}\`` : i.program} | ${what} | ${i.accounts ?? ""} |`);
  }
  out.push("");

  out.push("### Token balance changes", "");
  if (r.tokenChanges.length === 0) out.push("(none)");
  for (const t of r.tokenChanges) {
    out.push(`- mint \`${t.mint}\`${t.mint === MAINNET_USDC ? " (USDC)" : ""}, token account \`${t.tokenAccount}\`, owner \`${t.owner ?? "?"}\`: ${formatUnits(t.before, t.decimals)} -> ${formatUnits(t.after, t.decimals)}`);
  }
  out.push("", "### SOL balance changes", "");
  if (r.solChanges.length === 0) out.push("(none)");
  for (const s of r.solChanges) out.push(`- \`${s.address}\`: ${s.delta > 0n ? "+" : ""}${s.delta} lamports`);
  out.push("", "### Accounts created", "");
  if (r.createdAccounts.length === 0) out.push("(none)");
  for (const c of r.createdAccounts) out.push(`- \`${c.address}\`${c.owner ? `, owner program \`${c.owner}\`` : ""}`);
  out.push("", "### Logs", "", "```", ...r.logs.slice(0, 80), ...(r.logs.length > 80 ? [`… ${r.logs.length - 80} more lines`] : []), "```", "");
  return out.join("\n");
}
