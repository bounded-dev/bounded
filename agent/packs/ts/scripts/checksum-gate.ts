// checksum gate (TN-26-001, §"Dispute protocol": "Contract wrong mid-loop").
//
//   node checksum-gate.ts [targetDir]            verify against the manifest
//   node checksum-gate.ts --write [targetDir]    record the manifest
//
// The contract is the frozen, load-bearing shape the test-writer and builder
// both work against. If it moves silently mid-loop, tests and implementation
// drift apart under the orchestrator's feet. This gate proves the project's
// *.contract.ts files are byte-for-byte (newline-normalized) unchanged since
// they were recorded: sha256 per file, sorted by project-relative path, stored
// in .bounded/contract-checksums.json.
//
// --write records the manifest (run once the DESIGN stage's contracts are
// frozen). Default verifies and reports drift: changed / added / removed
// contracts, one greppable line each.
//
// Exit 0 no drift (or manifest written) · 1 drift · 2 misuse (no manifest to
// verify, no contract files, bad invocation). Logs one guard event to the
// target's .bounded/guard-log.jsonl.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { logGuardEvent, type GuardVerdict } from "../../../src/guard-log.ts";
import { activeTicketDesign, resolveTicketDesign } from "../../../src/ticket-design.ts";

const GUARD = "checksum-gate";
const LEGACY_MANIFEST = ".bounded/contract-checksums.json";
export function manifestRelative(root: string): string {
  // Location only: the ticket's own number decides it, whether or not its note
  // is readable yet or a sibling note disputes a contract.
  const state = resolveTicketDesign(root, { siblings: "ignore" });
  const ticket = state.kind === "ready" ? state.design.ticket : state.kind === "legacy" ? undefined : state.ticket;
  return ticket ? `.bounded/tickets/${ticket}/contract-checksums.json` : LEGACY_MANIFEST;
}
const CONTRACT_SUFFIX = ".contract.ts";
// `scratch` is the architect's sanctioned throwaway zone (src/path-policy.ts):
// a top-level directory nothing but the architect may write, and nothing may
// scaffold, freeze, or ship. This is the one place the project-wide walk skips
// it — so `findContractFiles`, the checksum/freeze manifest, the scaffolder's
// contract discovery and its orphan sync all ignore a scratch/*.contract.ts by
// construction, and a stray probe cannot be scaffolded, frozen, or ship.
const IGNORE_DIRS = new Set(["node_modules", ".git", ".bounded", ".agent-state", "scratch"]);

export interface Manifest {
  readonly files: Readonly<Record<string, string>>;
  readonly note?: { readonly path: string; readonly hash: string };
}

export interface Drift {
  readonly changed: string[];
  readonly added: string[];
  readonly removed: string[];
}

/**
 * Has this project ever been frozen? Callers that need to know whether a run
 * is a FIRST freeze or a RE-freeze ask here rather than hard-coding the path,
 * so the manifest location stays one string.
 */
export function hasManifest(root: string): boolean {
  return existsSync(join(root, manifestRelative(root)));
}

function relPosix(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/**
 * Every file under root whose basename satisfies `match`, sorted by
 * project-relative posix path.
 *
 * One walker, one ignore list. The scaffolder's orphan sync needs the same
 * traversal this gate needs, and a second copy of "which directories a project
 * scan skips" is a second thing to keep in step.
 */
export function findFilesUnder(root: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile() && match(entry.name)) {
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return out.sort((a, b) => (relPosix(root, a) < relPosix(root, b) ? -1 : 1));
}

/** All *.contract.ts files under root, sorted by project-relative posix path. */
export function findContractFiles(root: string): string[] {
  return findFilesUnder(root, (name) => name.endsWith(CONTRACT_SUFFIX));
}

/** sha256 over newline-normalized content — CRLF/LF churn is not drift. */
export function hashContract(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

export function computeManifest(root: string): Manifest {
  const files: Record<string, string> = {};
  const ticket = activeTicketDesign(root);
  const paths = ticket ? ticket.contracts.map((path) => join(root, path)) : findContractFiles(root);
  for (const path of paths) {
    files[relPosix(root, path)] = hashContract(readFileSync(path, "utf8"));
  }
  return ticket ? { files, note: { path: ticket.note, hash: hashContract(readFileSync(join(root, ticket.note), "utf8")) } } : { files };
}

export function diffManifests(stored: Manifest, current: Manifest): Drift {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [file, hash] of Object.entries(current.files)) {
    if (!(file in stored.files)) added.push(file);
    else if (stored.files[file] !== hash) changed.push(file);
  }
  for (const file of Object.keys(stored.files)) {
    if (!(file in current.files)) removed.push(file);
  }
  if (stored.note?.path !== current.note?.path) {
    if (stored.note) removed.push(stored.note.path);
    if (current.note) added.push(current.note.path);
  } else if (stored.note && current.note && stored.note.hash !== current.note.hash) {
    changed.push(current.note.path);
  }
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

export function hasDrift(drift: Drift): boolean {
  return drift.changed.length > 0 || drift.added.length > 0 || drift.removed.length > 0;
}

/** Deterministic serialization: sorted keys, trailing newline. */
export function serializeManifest(manifest: Manifest): string {
  const files: Record<string, string> = {};
  for (const key of Object.keys(manifest.files).sort()) files[key] = manifest.files[key];
  return JSON.stringify({ files, ...(manifest.note ? { note: manifest.note } : {}) }, null, 2) + "\n";
}

// --- CLI ------------------------------------------------------------------------

interface GateOutcome {
  readonly code: 0 | 1 | 2;
  readonly verdict: GuardVerdict;
  readonly summary: string;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly detail: Readonly<Record<string, unknown>>;
}

function runGate(cwd: string, write: boolean): GateOutcome {
  const manifestRelativePath = manifestRelative(cwd);
  const current = computeManifest(cwd);
  const fileCount = Object.keys(current.files).length;
  if (fileCount === 0) {
    return {
      code: 2,
      verdict: "error",
      summary: "no *.contract.ts files found",
      stdout: [],
      stderr: ["checksum-gate: no *.contract.ts files found — a gate that matches nothing is a broken gate"],
      detail: { reason: "no-contracts" },
    };
  }

  const manifestPath = join(cwd, manifestRelativePath);

  if (write) {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, serializeManifest(current));
    return {
      code: 0,
      verdict: "pass",
      summary: `wrote manifest (${fileCount} contract file${fileCount === 1 ? "" : "s"})`,
      stdout: [`checksum-gate: wrote ${manifestRelativePath} (${fileCount} contract file${fileCount === 1 ? "" : "s"})`],
      stderr: [],
      detail: { files: fileCount },
    };
  }

  if (!existsSync(manifestPath)) {
    return {
      code: 2,
      verdict: "error",
      summary: "no manifest to verify",
      stdout: [],
      stderr: [`checksum-gate: no manifest at ${manifestRelativePath} — run --write to record before verifying`],
      detail: { reason: "no-manifest" },
    };
  }

  let stored: Manifest;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as Manifest).files !== "object") {
      throw new Error("manifest is malformed");
    }
    stored = parsed as Manifest;
  } catch (e) {
    return {
      code: 2,
      verdict: "error",
      summary: "manifest unreadable",
      stdout: [],
      stderr: [`checksum-gate: cannot read ${manifestRelativePath} — ${e instanceof Error ? e.message : String(e)}`],
      detail: { reason: "bad-manifest" },
    };
  }

  const drift = diffManifests(stored, current);
  if (hasDrift(drift)) {
    const lines = [
      ...drift.changed.map((f) => `checksum-gate: drift changed ${f}`),
      ...drift.added.map((f) => `checksum-gate: drift added ${f}`),
      ...drift.removed.map((f) => `checksum-gate: drift removed ${f}`),
    ];
    const count = drift.changed.length + drift.added.length + drift.removed.length;
    const kind = current.note ? "design file" : "contract file";
    lines.push(`checksum-gate: FAIL — ${count} ${kind}${count === 1 ? "" : "s"} moved since the manifest was recorded`);
    return {
      code: 1,
      verdict: "block",
      summary: `drift in ${count} ${kind}${count === 1 ? "" : "s"}`,
      stdout: lines,
      stderr: [],
      detail: { changed: drift.changed, added: drift.added, removed: drift.removed },
    };
  }

  return {
    code: 0,
    verdict: "pass",
    summary: `OK (${fileCount} contract file${fileCount === 1 ? "" : "s"}, no drift)`,
    stdout: [`checksum-gate: OK — ${fileCount} contract file${fileCount === 1 ? "" : "s"}, no drift`],
    stderr: [],
    detail: { files: fileCount },
  };
}

export function parseArgs(argv: string[]): { write: boolean; cwd: string } {
  let write = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "--write") write = true;
    else positional.push(arg);
  }
  return { write, cwd: positional[0] ?? process.cwd() };
}

/**
 * Record (`write: true`) or verify the contract manifest, logging the verdict.
 *
 * The architect reaches this two ways — the freeze step of `design_gate`
 * (`write: true`) and the `check_drift` tool — because it has no shell to pass
 * `--write` through. Both, and the CLI, land here so there is one
 * implementation of "has the contract moved".
 */
export function runChecksumGate(
  cwd: string,
  write: boolean,
): { code: number; lines: readonly string[] } {
  const outcome = runGate(cwd, write);
  logGuardEvent(cwd, { guard: GUARD, verdict: outcome.verdict, summary: outcome.summary, detail: outcome.detail });
  return { code: outcome.code, lines: [...outcome.stdout, ...outcome.stderr] };
}

function main(argv: string[]): number {
  const { write, cwd } = parseArgs(argv);
  const outcome = runGate(cwd, write);
  for (const line of outcome.stdout) console.log(line);
  for (const line of outcome.stderr) console.error(line);
  logGuardEvent(cwd, { guard: GUARD, verdict: outcome.verdict, summary: outcome.summary, detail: outcome.detail });
  return outcome.code;
}

// Symlink-safe main check (invoked via the ~/.pi/agent symlink): compare realpaths.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`checksum-gate: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
