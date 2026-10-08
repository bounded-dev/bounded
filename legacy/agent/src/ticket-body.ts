// The body every ticket the lead creates carries (ADR LEG-2026-066). The command
// writes it from fixed sections, and every later command reads it back from
// the tracker, so a ticket edited by hand into another shape is refused rather
// than guessed at.

/** The sections, in order, exactly as headed in the issue body. */
export const TICKET_SECTIONS = ["Outcome", "Acceptance criteria", "Owned paths", "Dependencies", "Decisions to return"] as const;

export interface TicketFields {
  readonly title: string;
  readonly outcome: string;
  readonly acceptance: string;
  /** Project-relative contract paths this ticket alone may change. */
  readonly owns: readonly string[];
  /** Issues whose design handoff this ticket waits for. */
  readonly depends: readonly number[];
  readonly decisions: string;
}

export interface TicketBody {
  readonly owns: readonly string[];
  readonly depends: readonly number[];
}

/** A safe project-relative path: no leading slash, no `.` or `..` segment, no glob. */
const OWNED_PATH = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*(?:\/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*)*\/?$/;

export function validOwnedPath(path: string): boolean {
  return OWNED_PATH.test(path) && !path.split("/").some((part) => part === "." || part === "..");
}

const ISSUE_REF = /^#?([1-9][0-9]*)$/;

/** `12` or `#12`, as an issue number. */
export function parseIssueRef(ref: string): number | undefined {
  const match = ISSUE_REF.exec(ref.trim());
  return match === null ? undefined : Number(match[1]);
}

export type FieldsCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function checkTicketFields(fields: TicketFields): FieldsCheck {
  const blank = ([
    ["title", fields.title], ["outcome", fields.outcome], ["acceptance criteria", fields.acceptance],
    ["decisions to return", fields.decisions],
  ] as const).find(([, value]) => value.trim() === "");
  if (blank !== undefined) return { ok: false, reason: `a ticket needs its ${blank[0]}` };
  if (fields.title.includes("\n")) return { ok: false, reason: "a ticket title is one line" };
  if (fields.owns.length === 0) return { ok: false, reason: "a ticket needs at least one owned path" };
  const bad = fields.owns.find((path) => !validOwnedPath(path));
  if (bad !== undefined) return { ok: false, reason: `owned path '${bad}' must be a plain project-relative path` };
  if (new Set(fields.depends).size !== fields.depends.length) return { ok: false, reason: "a dependency is listed twice" };
  return { ok: true };
}

/** The issue body for `fields`, in the fixed section order. */
export function renderTicketBody(fields: TicketFields): string {
  const [outcome, acceptance, owned, dependencies, decisions] = TICKET_SECTIONS;
  return [
    `## ${outcome}`, "", fields.outcome.trim(), "",
    `## ${acceptance}`, "", fields.acceptance.trim(), "",
    `## ${owned}`, "", ...fields.owns.map((path) => `- \`${path}\``), "",
    `## ${dependencies}`, "", ...(fields.depends.length === 0 ? ["None"] : fields.depends.map((n) => `- #${n}`)), "",
    `## ${decisions}`, "", fields.decisions.trim(), "",
  ].join("\n");
}

export type ParsedBody = ({ readonly ok: true } & TicketBody) | { readonly ok: false; readonly reason: string };

/** Read a ticket body back. Every section must be present, in order, and filled. */
export function parseTicketBody(body: string): ParsedBody {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  const order: string[] = [];
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      current = [];
      sections.set(heading[1]!, current);
      order.push(heading[1]!);
      continue;
    }
    current?.push(line);
  }
  const expected = TICKET_SECTIONS.filter((name) => sections.has(name));
  if (expected.length !== TICKET_SECTIONS.length) {
    const missing = TICKET_SECTIONS.filter((name) => !sections.has(name));
    return { ok: false, reason: `the ticket body lacks section(s): ${missing.join(", ")}` };
  }
  const positions = TICKET_SECTIONS.map((name) => order.indexOf(name));
  if (positions.some((p, i) => i > 0 && p < positions[i - 1]!)) return { ok: false, reason: "the ticket body's sections are out of order" };
  const text = (name: string): string => (sections.get(name) ?? []).join("\n").trim();
  const empty = TICKET_SECTIONS.find((name) => text(name) === "");
  if (empty !== undefined) return { ok: false, reason: `the ticket body's '${empty}' section is empty` };

  const owns: string[] = [];
  for (const line of text("Owned paths").split("\n")) {
    if (line.trim() === "") continue;
    const match = /^[-*]\s+`?([^`\s]+)`?\s*$/.exec(line.trim());
    if (match === null || !validOwnedPath(match[1]!)) return { ok: false, reason: `owned path line '${line.trim()}' is not a plain path` };
    owns.push(match[1]!);
  }
  const deps = text("Dependencies");
  const depends: number[] = [];
  if (!/^none\.?$/i.test(deps)) {
    for (const line of deps.split("\n")) {
      if (line.trim() === "") continue;
      const match = /^[-*]\s+#([1-9][0-9]*)\s*$/.exec(line.trim());
      if (match === null) return { ok: false, reason: `dependency line '${line.trim()}' must read '- #<issue>'` };
      depends.push(Number(match[1]));
    }
  }
  return { ok: true, owns, depends };
}

const trimSlash = (path: string): string => path.replace(/\/+$/, "");

/** Whether two owned paths name the same file, or one lies inside the other. */
export function pathsOverlap(a: string, b: string): boolean {
  const x = trimSlash(a);
  const y = trimSlash(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** The first pair of `mine` and `theirs` that overlap, if any. */
export function ownershipConflict(mine: readonly string[], theirs: readonly string[]): readonly [string, string] | undefined {
  for (const a of mine) for (const b of theirs) if (pathsOverlap(a, b)) return [a, b];
  return undefined;
}
