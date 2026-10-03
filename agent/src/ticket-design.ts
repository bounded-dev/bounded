// Resolve the design owned by the active ticket. The TN is the durable prose;
// the contract paths in its front matter are the precise freeze surface.
//
// This module is the single owner of "which ticket is active": the selection
// file's path, the ticket-number shape and how the file is read. Other layers
// (the team lead's run boundary) add their own conditions on top of it.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { contractFileSuffixes, hasContractSuffix, sourceRootOf, sourceRoots } from "./pack-contrib.ts";
import { contestedContractRefusal, foreignContractRefusal } from "./ticket-route.ts";

export interface TicketDesign {
  readonly ticket: string;
  readonly note: string;
  readonly status: "draft" | "active" | "ratified" | "superseded";
  readonly contracts: readonly string[];
  /** The apps the note declares (TN-26-012 §9): `<dir>` → workspace kind.
   *  Shape-checked here; packs interpret it. Empty when absent. */
  readonly workspaces: Readonly<Record<string, string>>;
}

export interface TicketWriteScope {
  readonly ticket?: string;
  readonly contracts: readonly string[];
  /** Filename suffixes the composed packs contribute for contract files
   *  (ADR 2026-052). Empty when none is composed or the composition is
   *  unreadable — the latter always carries `error`. */
  readonly contractSuffixes: readonly string[];
  /** Contracts other tickets' live notes claim: path → the refusal naming
   *  their owner (or every claimant) and the route to change it. */
  readonly foreign?: Readonly<Record<string, string>>;
  /** Tickets with a frozen design, on which the lead prepares a change run. */
  readonly frozenTickets?: readonly string[];
  readonly error?: string;
}

/** Per-worktree selection of the active ticket, written by the team lead. */
export const ACTIVE_TICKET_RELATIVE = ".bounded/active-ticket";
/** A ticket number: a tracker issue number or a locally allocated one. */
export const TICKET_NUMBER = /^[1-9][0-9]*$/;

const INSTALLATION_RELATIVE = ".bounded/installation.json";
const TN_DIR = "docs/tn";
const TN_INDEX = "docs/tn/README.md";
/** Per-ticket harness state; `<n>/contract-checksums.json` is a frozen design. */
const TICKETS_DIR = ".bounded/tickets";
const NOTE_NAME = /^TN-([1-9][0-9]*)\.md$/;
/** The safe project-relative shape of a contract path. Which directory it must
 *  sit under (a source root, ADR 2026-056) and the filename suffix that makes
 *  it a contract (ADR 2026-052) come from the composed packs. */
const CONTRACT_PATH = /^(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+$/;
/** One `workspaces:` entry (TN-26-012 §9): `  <dir>: <kind>`. */
const WORKSPACE_LINE = /^  ([a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*): ([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;

const UNSELECTED =
  "no active ticket — select the current issue with the team lead (it records " +
  `${ACTIVE_TICKET_RELATIVE}) or set BOUNDED_TICKET=<issue number>`;

export type ActiveTicketFile =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "selected"; readonly ticket: string };

/** Read the lead's selection file as it stands, without any run condition. */
export function readActiveTicketFile(root: string): ActiveTicketFile {
  const path = join(root, ACTIVE_TICKET_RELATIVE);
  let isFile: boolean;
  try {
    isFile = lstatSync(path).isFile();
  } catch {
    return { kind: "absent" };
  }
  if (!isFile) return { kind: "invalid", reason: `${ACTIVE_TICKET_RELATIVE} is not a regular file` };
  let recorded: string;
  try {
    recorded = readFileSync(path, "utf8").trim();
  } catch {
    return { kind: "invalid", reason: `${ACTIVE_TICKET_RELATIVE} cannot be read` };
  }
  return TICKET_NUMBER.test(recorded)
    ? { kind: "selected", ticket: recorded }
    : { kind: "invalid", reason: `${ACTIVE_TICKET_RELATIVE} is malformed` };
}

type Selection = { readonly ticket: string } | { readonly error: string };

function selectTicket(root: string): Selection {
  const override = process.env.BOUNDED_TICKET;
  if (override !== undefined && override !== "") {
    return TICKET_NUMBER.test(override)
      ? { ticket: override }
      : { error: `BOUNDED_TICKET='${override}' is not a positive issue number` };
  }
  if (!existsSync(join(root, INSTALLATION_RELATIVE))) return { error: UNSELECTED };
  const file = readActiveTicketFile(root);
  if (file.kind === "selected") return { ticket: file.ticket };
  return { error: file.kind === "invalid" ? `${file.reason}; ${UNSELECTED}` : UNSELECTED };
}

/** The lead selects one ticket for this worktree. An explicit, nonempty
 * BOUNDED_TICKET remains available to direct launchers and takes precedence;
 * the selection file counts only in a project-local installation. */
export function activeTicketNumber(root: string): string | undefined {
  const selection = selectTicket(root);
  return "ticket" in selection ? selection.ticket : undefined;
}

function suffixesFor(root: string): readonly string[] {
  try {
    return contractFileSuffixes(root);
  } catch (error) {
    throw new Error(`cannot tell which files are contracts: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function rootsFor(root: string): readonly string[] {
  try {
    return sourceRoots(root);
  } catch (error) {
    throw new Error(`cannot tell where source lives: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkContractPath(path: string, suffixes: readonly string[], roots: readonly string[], note: string): void {
  if (!CONTRACT_PATH.test(path) || path.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new Error(`unsafe contract path '${path}' in ${note}`);
  }
  if (sourceRootOf(path, roots) === undefined) {
    throw new Error(roots.length === 0
      ? `${note} lists '${path}', but no composed pack declares a source root, so no file is a contract`
      : `${note} lists '${path}', which is outside every source root (${roots.join(", ")})`);
  }
  if (!hasContractSuffix(path, suffixes)) {
    throw new Error(suffixes.length === 0
      ? `${note} lists '${path}', but no composed pack declares a contract file type`
      : `${note} lists '${path}', which is not a contract file (${suffixes.join(", ")})`);
  }
}

function safeContract(root: string, path: string, note: string): void {
  const absolute = join(root, path);
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
    throw new Error(`${note} names missing contract '${path}'`);
  }
  const rel = relative(realpathSync(root), realpathSync(absolute)).split(sep).join("/");
  if (rel !== path) throw new Error(`contract '${path}' escapes the project or uses a symlink`);
}

interface FrontMatter {
  readonly lines: readonly string[];
  readonly body: string;
}

function frontMatter(body: string): FrontMatter | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  return match ? { lines: match[1]!.split(/\r?\n/), body } : undefined;
}

/** The `contracts:` list; undefined when malformed, [] when absent. */
function contractList(lines: readonly string[]): string[] | undefined {
  const start = lines.findIndex((line) => line === "contracts:");
  const contracts: string[] = [];
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (!/^\s/.test(line)) break;
    const item = /^  - (.+)$/.exec(line);
    if (!item) return undefined;
    contracts.push(item[1]!.trim());
  }
  return contracts;
}

/** Parse the ACTIVE ticket's own note strictly. `freeze` also requires every
 * owned contract to exist as a regular in-project file and refuses a
 * superseded note; the write scope parses a draft that may name contracts
 * not created yet. */
function parseActiveNote(root: string, ticket: string, freeze: boolean): TicketDesign {
  const note = `${TN_DIR}/TN-${ticket}.md`;
  const body = readFileSync(join(root, note), "utf8");
  const fm = frontMatter(body);
  if (!fm) throw new Error(`${note} needs TN front matter`);
  const issue = fm.lines.find((line) => line.startsWith("issue:"))?.slice(6).trim();
  if (issue !== ticket) throw new Error(`${note} must declare issue: ${ticket}`);
  const status = fm.lines.find((line) => line.startsWith("status:"))?.slice(7).trim();
  if (!status || !["draft", "active", "ratified", "superseded"].includes(status)) {
    throw new Error(`${note} needs a valid status`);
  }
  if (status === "superseded" && freeze) throw new Error(`${note} is superseded and cannot be frozen`);
  if (status === "superseded") {
    const successors = [...body.matchAll(/\]\(TN-([1-9][0-9]*)\.md\)/g)].map((match) => match[1]!);
    if (!successors.length || successors.some((next) => next === ticket ||
      !existsSync(join(root, `${TN_DIR}/TN-${next}.md`)))) {
      throw new Error(`${note} must link to an existing successor TN`);
    }
  }
  if (freeze && !fm.lines.includes("contracts:")) throw new Error(`${note} needs a contracts: list`);
  const contracts = contractList(fm.lines);
  if (!contracts) throw new Error(`${note} has an invalid contracts: list`);
  if ((freeze && !contracts.length) || new Set(contracts).size !== contracts.length) {
    throw new Error(`${note} needs distinct owned contracts`);
  }
  if (contracts.length) {
    const suffixes = suffixesFor(root);
    const roots = rootsFor(root);
    for (const path of contracts) {
      checkContractPath(path, suffixes, roots, note);
      if (freeze) safeContract(root, path, note);
    }
  }
  const workspaces = workspaceMap(fm.lines);
  if (typeof workspaces === "string") throw new Error(`${note} ${workspaces}`);
  return { ticket, note, status: status as TicketDesign["status"], contracts: contracts.sort(), workspaces };
}

/**
 * The `workspaces:` map (TN-26-012 §9): the apps a ticket declares, as
 * `<dir>: <kind>`. Block form only; absent is an empty map, and so is a bare
 * `workspaces:`. The core checks the shape alone — which kinds exist and
 * where their directories may live is the composed packs' business. A
 * malformed block is a string saying what is wrong.
 */
export function workspaceMap(lines: readonly string[]): Readonly<Record<string, string>> | string {
  const starts = lines.filter((line) => /^workspaces\s*:/.test(line));
  if (starts.length === 0) return {};
  if (starts.length > 1 || starts[0] !== "workspaces:") {
    return "needs one block-form 'workspaces:' line with nothing after the colon";
  }
  const map: Record<string, string> = {};
  for (const line of lines.slice(lines.indexOf("workspaces:") + 1)) {
    if (!/^\s/.test(line)) break;
    const entry = WORKSPACE_LINE.exec(line);
    if (entry === null) {
      return `has an invalid workspaces: entry '${line.trim()}' — each is '  <dir>: <kind>', lowercase, such as '  apps/web: web'`;
    }
    const [, dir, kind] = entry as unknown as [string, string, string];
    if (Object.hasOwn(map, dir)) return `declares workspace '${dir}' twice`;
    map[dir] = kind;
  }
  return map;
}

/**
 * Another ticket's note matters to this ticket only through the contracts it
 * claims. Its own hygiene (issue line, status, successor link) is checked when
 * THAT ticket is active, so a stale neighbour never blocks this one — unless it
 * cannot be read at all, in which case ownership cannot be proven.
 *
 * A claim alone does not decide ownership: a note can list anything. The
 * ticket whose frozen design holds the contract owns it. Among several
 * claimants with no single such freeze, nobody can be named as the owner, so
 * the refusal names them all.
 */
type SiblingClaims =
  | { readonly ok: true; readonly foreign: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly error: string };

/** A ticket's frozen manifest; a ticket is frozen when it exists. */
function manifestPath(ticket: string): string {
  return `${TICKETS_DIR}/${ticket}/contract-checksums.json`;
}

function isFrozen(root: string, ticket: string): boolean {
  return existsSync(join(root, manifestPath(ticket)));
}

/** Whether `ticket`'s frozen design holds `path`. Unreadable is no. */
function frozeContract(root: string, ticket: string, path: string): boolean {
  try {
    const files = (JSON.parse(readFileSync(join(root, manifestPath(ticket)), "utf8")) as { files?: unknown }).files;
    return typeof files === "object" && files !== null && Object.hasOwn(files, path);
  } catch {
    return false;
  }
}

/** Tickets with a frozen design: the lead prepares a change run on these. */
function frozenTickets(root: string): string[] {
  try {
    return readdirSync(join(root, TICKETS_DIR)).filter((t) => TICKET_NUMBER.test(t) && isFrozen(root, t)).sort();
  } catch {
    return [];
  }
}

/** The refusal for `path` among `claimants` (never empty), seen from `active`;
 *  undefined when the active ticket's own freeze makes it the owner. */
function ownershipRefusal(root: string, path: string, claimants: readonly string[], active: string): string | undefined {
  const sorted = [...claimants].sort((a, b) => Number(a) - Number(b));
  const froze = sorted.filter((t) => frozeContract(root, t, path));
  const owner = froze.length === 1 ? froze[0] : froze.length === 0 && sorted.length === 1 ? sorted[0] : undefined;
  if (owner === undefined) return contestedContractRefusal(path, sorted);
  if (owner === active) return undefined;
  return foreignContractRefusal(path, { ticket: owner, frozen: isFrozen(root, owner) }, active);
}

function siblingClaims(root: string, ticket: string, contracts: readonly string[]): SiblingClaims {
  let entries: string[];
  try {
    entries = readdirSync(join(root, TN_DIR));
  } catch {
    return { ok: true, foreign: {} };
  }
  const claims = new Map<string, string[]>();
  for (const entry of entries.sort()) {
    // The claimant is named by the note's file: its issue line is that
    // ticket's own hygiene, checked when it is active.
    const named = NOTE_NAME.exec(entry)?.[1];
    if (!named || named === ticket) continue;
    const note = `${TN_DIR}/${entry}`;
    const repair = `ask the team lead to repair ${note} (it belongs to ticket #${named}, not #${ticket})`;
    let body: string;
    try {
      body = readFileSync(join(root, note), "utf8");
    } catch {
      return { ok: false, error: `cannot read ${note}, so ticket #${ticket}'s contract ownership cannot be checked — ${repair}` };
    }
    const fm = frontMatter(body);
    if (!fm) {
      return { ok: false, error: `${note} has no readable TN front matter, so ticket #${ticket}'s contract ownership cannot be checked — ${repair}` };
    }
    const status = fm.lines.find((line) => line.startsWith("status:"))?.slice(7).trim();
    if (status === "superseded") continue;
    const claimed = contractList(fm.lines);
    if (!claimed) {
      return { ok: false, error: `${note} has an unreadable contracts: list, so ticket #${ticket}'s contract ownership cannot be checked — ${repair}` };
    }
    for (const path of new Set(claimed)) claims.set(path, [...(claims.get(path) ?? []), named]);
  }
  for (const path of contracts) {
    const others = claims.get(path);
    if (others === undefined) continue;
    const refusal = ownershipRefusal(root, path, [ticket, ...others], ticket);
    if (refusal !== undefined) return { ok: false, error: refusal };
  }
  const foreign: Record<string, string> = {};
  for (const [path, others] of claims) {
    if (contracts.includes(path)) continue;
    // Never undefined: the active ticket is not among these claimants.
    foreign[path] = ownershipRefusal(root, path, others, ticket) ?? contestedContractRefusal(path, others);
  }
  return { ok: true, foreign };
}

function siblingConflict(root: string, active: TicketDesign): string | undefined {
  const claims = siblingClaims(root, active.ticket, active.contracts);
  return claims.ok ? undefined : claims.error;
}

export interface TicketDesignOptions {
  /** "check" (default) refuses when another ticket's note claims one of this
   *  ticket's contracts or cannot be read. "ignore" resolves this ticket alone,
   *  for readers that only need its own design (the spawn check re-verifies
   *  the design against its freeze, which already checked ownership). */
  readonly siblings?: "check" | "ignore";
}

export type TicketDesignState =
  /** A project created before ticket-numbered TNs. */
  | { readonly kind: "legacy" }
  /** A ticket is selected and its TN is not written yet — the architect's
   *  starting point, not an error. */
  | { readonly kind: "unwritten"; readonly ticket: string; readonly note: string }
  | { readonly kind: "ready"; readonly design: TicketDesign }
  /** A precise, actionable reason the design cannot be used. */
  | { readonly kind: "refused"; readonly ticket?: string; readonly reason: string };

/** Resolve the active ticket's design for freeze-grade use. Never throws. */
export function resolveTicketDesign(root: string, options: TicketDesignOptions = {}): TicketDesignState {
  if (!existsSync(join(root, TN_INDEX))) return { kind: "legacy" };
  const selection = selectTicket(root);
  if (!("ticket" in selection)) return { kind: "refused", reason: selection.error };
  const { ticket } = selection;
  const note = `${TN_DIR}/TN-${ticket}.md`;
  if (!existsSync(join(root, note))) return { kind: "unwritten", ticket, note };
  try {
    const design = parseActiveNote(root, ticket, true);
    const conflict = options.siblings === "ignore" ? undefined : siblingConflict(root, design);
    return conflict ? { kind: "refused", ticket, reason: conflict } : { kind: "ready", design };
  } catch (error) {
    return { kind: "refused", ticket, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Undefined only for projects created before ticket-numbered TNs; throws a
 * precise reason when the design cannot be reviewed or frozen. */
export function activeTicketDesign(root: string, options: TicketDesignOptions = {}): TicketDesign | undefined {
  const state = resolveTicketDesign(root, options);
  switch (state.kind) {
    case "legacy":
      return undefined;
    case "ready":
      return state.design;
    case "unwritten":
      throw new Error(`ticket #${state.ticket} needs ${state.note} before design review or freeze`);
    case "refused":
      throw new Error(state.reason);
  }
}

/** Resolve ownership for path writes, including a not-yet-created contract.
 * Never throws: a problem becomes `error`, refused on contract writes. */
export function ticketWriteScope(root: string): TicketWriteScope | undefined {
  if (!existsSync(join(root, TN_INDEX))) return undefined;
  const frozen = { frozenTickets: frozenTickets(root) };
  let suffixes: readonly string[] = [];
  try {
    suffixes = suffixesFor(root);
  } catch (error) {
    const selected = activeTicketNumber(root);
    return {
      ...(selected !== undefined ? { ticket: selected } : {}),
      contracts: [], contractSuffixes: [], ...frozen,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const selection = selectTicket(root);
  if (!("ticket" in selection)) return { contracts: [], contractSuffixes: suffixes, ...frozen, error: selection.error };
  const { ticket } = selection;
  if (!existsSync(join(root, `${TN_DIR}/TN-${ticket}.md`))) {
    // Unwritten: nothing to conflict with, but a refusal can still name owners.
    const claims = siblingClaims(root, ticket, []);
    return { ticket, contracts: [], contractSuffixes: suffixes, ...frozen, ...(claims.ok ? { foreign: claims.foreign } : {}) };
  }
  try {
    const active = parseActiveNote(root, ticket, false);
    const claims = siblingClaims(root, ticket, active.contracts);
    if (!claims.ok) return { ticket, contracts: [], contractSuffixes: suffixes, ...frozen, error: claims.error };
    return { ticket, contracts: active.contracts, contractSuffixes: suffixes, ...frozen, foreign: claims.foreign };
  } catch (error) {
    return { ticket, contracts: [], contractSuffixes: suffixes, ...frozen, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The design note's path: the active ticket's TN (written or not), or root
 * spec.md in a legacy project. Throws only when no ticket is selected. */
export function designNotePath(root: string): string {
  if (!existsSync(join(root, TN_INDEX))) return "spec.md";
  const selection = selectTicket(root);
  if (!("ticket" in selection)) throw new Error(selection.error);
  return `${TN_DIR}/TN-${selection.ticket}.md`;
}
