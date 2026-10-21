// What the doctor says: one line per check, grouped by section, and a verdict. Plain text with no colour, so it reads the
// same in a terminal, a log and a pasted message.

export type Status = "ok" | "warn" | "fail" | "skip";

export interface Check {
  section: string;
  title: string;
  status: Status;
  /** What was found. May hold several lines. */
  detail: string;
  /** What to do about it (for `warn` and `fail`). */
  fix?: string;
}

export interface Report {
  checks: Check[];
  ok: number;
  warned: number;
  failed: number;
  skipped: number;
  /** Nothing failed: the keeper can start. Warnings do not stop it. */
  ready: boolean;
}

export function summarize(checks: Check[]): Report {
  const count = (s: Status) => checks.filter((c) => c.status === s).length;
  return { checks, ok: count("ok"), warned: count("warn"), failed: count("fail"), skipped: count("skip"), ready: count("fail") === 0 };
}

const MARK: Record<Status, string> = { ok: "[ ok ]", warn: "[warn]", fail: "[FAIL]", skip: "[skip]" };
const INDENT = "         ";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function render(report: Report): string {
  const out: string[] = ["Keeper doctor. Read-only: nothing was sent to the chain and nothing was written anywhere.", ""];
  const sections = [...new Set(report.checks.map((c) => c.section))];
  sections.forEach((name, i) => {
    if (i > 0) out.push("");
    out.push(name);
    const checks = report.checks.filter((c) => c.section === name);
    // A section where nothing could be looked at says so once, instead of repeating what it is waiting for.
    if (checks.length > 1 && checks.every((c) => c.status === "skip")) {
      out.push(`  ${MARK.skip} all ${checks.length} checks: ${[...new Set(checks.map((c) => c.detail))].join("; ")}`);
      return;
    }
    for (const c of checks) {
      if (c.status === "skip") {
        out.push(`  ${MARK.skip} ${c.title}: ${c.detail}`);
        continue;
      }
      out.push(`  ${MARK[c.status]} ${c.title}`);
      for (const line of c.detail.split("\n")) if (line !== "") out.push(`${INDENT}${line}`);
      if (c.fix && c.status !== "ok") out.push(`${INDENT}to fix: ${c.fix}`);
    }
  });
  out.push("");
  const tail = `${plural(report.ok, "check passed", "checks passed")}, ${plural(report.warned, "warning", "warnings")}, ${plural(report.failed, "failure", "failures")}, ${report.skipped} skipped`;
  out.push(report.ready ? `READY. ${tail}.` : `NOT READY. ${tail}.`);
  if (report.ready && report.warned > 0) out.push("The keeper will start; read the warnings first.");
  if (report.skipped > 0 && !report.ready) out.push("Skipped checks depend on one that failed: fix that one first.");
  return out.join("\n");
}

/**
 * A function that hides secrets in any text. The doctor prints what the node, the database and the filesystem say, and an
 * error message from any of them may repeat the address it was given (a provider's RPC url holds an API key).
 */
export function scrubber(secrets: readonly string[]): (text: string) => string {
  // Longest first, so a url is hidden whole before the password inside it.
  const list = [...new Set(secrets.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
  return (text) => list.reduce((acc, s) => acc.split(s).join("[hidden]"), text);
}

/**
 * The parts of a url that can be a secret. A node's url holds its API key in the path or the query, so those are hidden as well;
 * a database url holds a password, and its path is only the database's name, which is not worth hiding (and would be hidden
 * from every message that mentions a table of the same name).
 */
export function urlSecrets(raw: string | undefined, kind: "rpc" | "db"): string[] {
  if (!raw) return [];
  const secrets = [raw];
  try {
    const u = new URL(raw);
    if (u.password) secrets.push(decodeURIComponent(u.password), u.password);
    if (kind === "rpc") {
      if (u.username) secrets.push(decodeURIComponent(u.username), u.username);
      const tail = `${u.pathname}${u.search}`.replace(/^\/+|\/+$/g, "");
      if (tail.length >= 6) secrets.push(tail);
      for (const [, value] of u.searchParams) if (value.length >= 6) secrets.push(value);
      // A key that is a part of the path on its own (".../v2/<key>", ".../ping/<uuid>"); short parts are names, not keys.
      for (const part of u.pathname.split("/")) if (part.length >= 12) secrets.push(decodeURIComponent(part), part);
    }
  } catch {
    // Not a url: the whole text is hidden, which is the safe side.
  }
  return secrets;
}
