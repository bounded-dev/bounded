// Reads the text of bounded/prereqs's status file, `.bounded/prereqs/status.json`
// (ADR 2026-026), into its file form, or says why it cannot be used (ADR
// 2026-027). By hand, with no library: a hooks module loads only its own
// files. It checks the file's shape, the same shape bounded/prereqs's value
// object accepts plus the project's root, and none of the content rules of
// agent names, file patterns or program prefixes, which the band only shows.
// The format is read straight after the JSON parse, before anything else, so a
// file of another format is named as such whatever else it holds.

/** The status file's format this band reads. */
export const PREREQS_STATUS_FORMAT = "bounded-prereqs-status/1";
/** Where a project loads the band from that matches its installed bounded. */
export const BAND_FOLDER = "node_modules/bounded/dist/hosts/claude-code/prereqs-status-band";
/** Where the status file is, under the project's root. */
export const STATUS_FILE = ".bounded/prereqs/status.json";

export type RequirementStatus = "holds" | "pending" | "stale" | "missing";

/** One requirement as the reading found it. */
export interface StatusFileRequirement {
  readonly key: string;
  readonly requiredAgent: string;
  readonly unchangedSince: readonly string[];
  readonly status: RequirementStatus;
  readonly filesMatched: number;
  readonly pendingRun: { readonly agentRunId: string; readonly startedAt: string } | null;
}

/** The action a rule comes before, as bounded/prereqs's wire form gives it: exactly one of the three. */
export type StatusFileBefore = { readonly delegate: string } | { readonly write: string } | { readonly execute: string };

/** One rule as the reading found it, in contribution order. */
export interface StatusFileRule {
  readonly contributedBy: string;
  readonly before: StatusFileBefore;
  readonly requirementKey: string;
  readonly allows: boolean;
}

/** A status file whose reading finished. */
export interface ReadStatusFile {
  readonly format: typeof PREREQS_STATUS_FORMAT;
  readonly outcome: "read";
  readonly readingStartedAt: string;
  readonly requirements: readonly StatusFileRequirement[];
  readonly rules: readonly StatusFileRule[];
  readonly projectRoot: string;
}

/** A status file whose reading could not be made, and why. */
export interface UnreadStatusFile {
  readonly format: typeof PREREQS_STATUS_FORMAT;
  readonly outcome: "unread";
  readonly readingStartedAt: string;
  readonly why: string;
  readonly projectRoot: string;
}

export type StatusFile = ReadStatusFile | UnreadStatusFile;

/** Why a status file's text cannot be used: not JSON or not an object; another format; or a shape the band refuses, naming the field. */
export type StatusFileRefusal = { readonly ok: false; readonly kind: "malformed" | "format-mismatch" | "shape"; readonly why: string };

export type StatusFileReading = { readonly ok: true; readonly value: StatusFile } | StatusFileRefusal;

const READ_KEYS = ["format", "outcome", "readingStartedAt", "requirements", "rules", "projectRoot"];
const UNREAD_KEYS = ["format", "outcome", "readingStartedAt", "why", "projectRoot"];
const REQUIREMENT_KEYS = ["key", "requiredAgent", "unchangedSince", "status", "filesMatched", "pendingRun"];
const RULE_KEYS = ["contributedBy", "before", "requirementKey", "allows"];
const STATUSES: readonly RequirementStatus[] = ["holds", "pending", "stale", "missing"];

/** Thrown inside shapeOf to stop at the first refused field; readStatusFile turns it into a refusal. */
class ShapeRefused {
  readonly why: string;

  constructor(why: string) {
    this.why = why;
  }
}

const refuse = (why: string): never => {
  throw new ShapeRefused(why);
};

/** A plain object's own field, read safely. */
function field(raw: object, name: string): unknown {
  return Object.getOwnPropertyDescriptor(raw, name)?.value;
}

function isRecord(raw: unknown): raw is object {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** Refuses `raw` unless its keys are exactly `keys`, naming a missing or unknown one. */
function exactKeys(raw: object, keys: readonly string[], what: string): void {
  const own = Object.keys(raw);
  const unknown = own.find((name) => !keys.includes(name));
  if (unknown !== undefined) refuse(`${what} has a key it does not know: ${unknown}`);
  const missing = keys.find((name) => !own.includes(name));
  if (missing !== undefined) refuse(`${what} has no ${missing}`);
}

function text(raw: object, name: string, what: string): string {
  const value = field(raw, name);
  if (typeof value !== "string" || value.trim() === "") refuse(`${what}'s ${name} is not a non-empty string`);
  return value as string;
}

/** An ISO 8601 time in UTC, as Date.prototype.toISOString writes it (bounded's DecisionTime test). */
function time(raw: object, name: string, what: string): string {
  const value = field(raw, name);
  let isIso = false;
  try {
    isIso = typeof value === "string" && new Date(value).toISOString() === value;
  } catch {
    isIso = false;
  }
  if (!isIso) refuse(`${what}'s ${name} is not an ISO 8601 time in UTC`);
  return value as string;
}

/** The key bounded/prereqs gives the requirement of `agent` over `patterns`. */
function requirementKeyOf(agent: string, patterns: readonly string[]): string {
  return JSON.stringify([agent, [...new Set(patterns)].sort()]);
}

function requirementOf(raw: unknown, what: string): StatusFileRequirement {
  if (!isRecord(raw)) return refuse(`${what} is not an object`);
  exactKeys(raw, REQUIREMENT_KEYS, what);
  const requiredAgent = text(raw, "requiredAgent", what);
  const patterns = field(raw, "unchangedSince");
  if (!Array.isArray(patterns) || patterns.length === 0 || !patterns.every((pattern) => typeof pattern === "string" && pattern.trim() !== "")) {
    return refuse(`${what}'s unchangedSince is not a non-empty list of file patterns`);
  }
  const unchangedSince: string[] = patterns;
  const key = field(raw, "key");
  if (key !== requirementKeyOf(requiredAgent, unchangedSince)) refuse(`${what}'s key is not the key of its requiredAgent and unchangedSince`);
  const status = STATUSES.find((known) => known === field(raw, "status"));
  if (status === undefined) return refuse(`${what}'s status is not holds, pending, stale or missing`);
  const filesMatched = field(raw, "filesMatched");
  if (typeof filesMatched !== "number" || !Number.isSafeInteger(filesMatched) || filesMatched < 0) return refuse(`${what}'s filesMatched is not a whole number, 0 or more`);
  if (filesMatched === 0 && status !== "missing") refuse(`${what}'s filesMatched is 0, so its status is missing`);
  const rawRun = field(raw, "pendingRun");
  let pendingRun: StatusFileRequirement["pendingRun"] = null;
  if (rawRun !== null) {
    if (!isRecord(rawRun)) return refuse(`${what}'s pendingRun is not null or { agentRunId, startedAt }`);
    exactKeys(rawRun, ["agentRunId", "startedAt"], `${what}'s pendingRun`);
    pendingRun = { agentRunId: text(rawRun, "agentRunId", `${what}'s pendingRun`), startedAt: time(rawRun, "startedAt", `${what}'s pendingRun`) };
  }
  if ((pendingRun !== null) !== (status === "pending")) refuse(`${what}'s pendingRun is present exactly when its status is pending`);
  return { key: key as string, requiredAgent, unchangedSince, status, filesMatched, pendingRun };
}

function beforeOf(raw: unknown, what: string): StatusFileBefore {
  if (!isRecord(raw)) return refuse(`${what}'s before is not an object`);
  const keys = Object.keys(raw);
  const [only] = keys;
  if (keys.length !== 1 || (only !== "delegate" && only !== "write" && only !== "execute")) return refuse(`${what}'s before names exactly one of delegate, write or execute`);
  const value = text(raw, only, `${what}'s before`);
  if (only === "delegate") return { delegate: value };
  if (only === "write") return { write: value };
  return { execute: value };
}

function ruleOf(raw: unknown, what: string, requirements: readonly StatusFileRequirement[]): StatusFileRule {
  if (!isRecord(raw)) return refuse(`${what} is not an object`);
  exactKeys(raw, RULE_KEYS, what);
  const contributedBy = text(raw, "contributedBy", what);
  const before = beforeOf(field(raw, "before"), what);
  const requirementKey = field(raw, "requirementKey");
  const requirement = requirements.find((listed) => listed.key === requirementKey);
  if (requirement === undefined) return refuse(`${what}'s requirementKey names no requirement in the file`);
  const allows = field(raw, "allows");
  if (typeof allows !== "boolean") return refuse(`${what}'s allows is not true or false`);
  if (allows !== (requirement.status === "holds")) refuse(`${what}'s allows is not whether its requirement holds`);
  return { contributedBy, before, requirementKey: requirement.key, allows };
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function shapeOf(raw: object): StatusFile {
  const outcome = field(raw, "outcome");
  if (outcome !== "read" && outcome !== "unread") return refuse(`the file's outcome is not "read" or "unread"`);
  exactKeys(raw, outcome === "read" ? READ_KEYS : UNREAD_KEYS, `the ${outcome} file`);
  const readingStartedAt = time(raw, "readingStartedAt", "the file");
  const projectRoot = field(raw, "projectRoot");
  if (typeof projectRoot !== "string" || !isAbsolute(projectRoot)) refuse("the file's projectRoot is not an absolute path");
  const root = projectRoot as string;
  if (outcome === "unread") {
    const why = text(raw, "why", "the file");
    return { format: PREREQS_STATUS_FORMAT, outcome, readingStartedAt, why, projectRoot: root };
  }
  const rawRequirements = field(raw, "requirements");
  if (!Array.isArray(rawRequirements)) return refuse("the file's requirements are not a list");
  const requirements: StatusFileRequirement[] = [];
  for (const [index, item] of rawRequirements.entries()) {
    const requirement = requirementOf(item, `requirement ${index + 1}`);
    const earlier = requirements.findIndex((listed) => listed.key === requirement.key);
    if (earlier !== -1) refuse(`requirement ${index + 1}'s key repeats requirement ${earlier + 1}'s`);
    requirements.push(requirement);
  }
  const rawRules = field(raw, "rules");
  if (!Array.isArray(rawRules)) return refuse("the file's rules are not a list");
  const rules = rawRules.map((item: unknown, index) => ruleOf(item, `rule ${index + 1}`, requirements));
  return { format: PREREQS_STATUS_FORMAT, outcome, readingStartedAt, requirements, rules, projectRoot: root };
}

/** Reads the status file's text: its file form, or why it cannot be used. Never throws. */
export function readStatusFile(fileText: string): StatusFileReading {
  let raw: unknown;
  try {
    raw = JSON.parse(fileText);
  } catch {
    return { ok: false, kind: "malformed", why: `${STATUS_FILE} is not JSON` };
  }
  if (!isRecord(raw)) return { ok: false, kind: "malformed", why: `${STATUS_FILE} is JSON but not a JSON object` };
  const format = field(raw, "format");
  if (format !== PREREQS_STATUS_FORMAT) {
    const found = typeof format === "string" ? `is in format ${format}` : "has no format";
    return { ok: false, kind: "format-mismatch", why: `${STATUS_FILE} ${found}, and this band reads ${PREREQS_STATUS_FORMAT}: load the band that ships with the project's bounded, from ${BAND_FOLDER}` };
  }
  try {
    return { ok: true, value: shapeOf(raw) };
  } catch (thrown) {
    if (thrown instanceof ShapeRefused) return { ok: false, kind: "shape", why: `${STATUS_FILE} is malformed: ${thrown.why}` };
    return { ok: false, kind: "shape", why: `${STATUS_FILE} could not be read: ${thrown instanceof Error ? thrown.message : String(thrown)}` };
  }
}
