import type { prerequisiteStartBrand } from "./prerequisite-start.contract.ts";
import { AgentName, own, type Result, readSafely, sameWire, wireFormOf } from "bounded/domain";
import { checkFilePattern } from "./file-set.ts";
import { FileSetFingerprint } from "./file-set-fingerprint.ts";
import type * as Contract from "./prerequisite-start.contract.ts";

const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** The key of a requirement: an agent, ignoring case, and its patterns, in any order, each once. */
export function requirementKeyOf(agent: AgentName, patterns: readonly string[]): string {
  return JSON.stringify([agent.value.toLowerCase(), [...new Set(patterns)].sort()]);
}

/** The fields a start and a record share, read from `raw` and checked, each refusal naming `what` and its field. */
export interface RequirementFields {
  readonly delegate: AgentName;
  readonly unchangedSince: readonly [string, ...string[]];
  readonly fingerprint: FileSetFingerprint;
}

/** Reads and checks a start's or a record's shared fields; `raw` has exactly the keys the caller allows. */
export function parseRequirementFields(raw: object, what: string): Result<RequirementFields> {
  const delegate = AgentName.parse(own(raw, "delegate"));
  if (!delegate.ok) return refuse(`${what}'s delegate: ${delegate.error}`);
  const patterns = own(raw, "unchangedSince");
  if (!Array.isArray(patterns) || patterns.length === 0) return refuse(`${what}'s unchangedSince is a non-empty list of file patterns`);
  const checked: string[] = [];
  for (const pattern of patterns) {
    const tidy = checkFilePattern(pattern, "unchangedSince");
    if (!tidy.ok) return refuse(`${what}'s unchangedSince: ${tidy.error}`);
    checked.push(tidy.value);
  }
  const [first, ...rest] = checked;
  if (first === undefined) return refuse(`${what}'s unchangedSince is a non-empty list of file patterns`);
  const fingerprint = FileSetFingerprint.parse(own(raw, "fingerprint"));
  if (!fingerprint.ok) return refuse(`${what}'s fingerprint: ${fingerprint.error}`);
  return { ok: true, value: { delegate: delegate.value, unchangedSince: Object.freeze([first, ...rest] as const), fingerprint: fingerprint.value } };
}

/** Whether `raw` is an object with exactly `keys`. */
export const hasExactly = (raw: unknown, keys: readonly string[]): raw is object =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.keys(raw).length === keys.length && keys.every((key) => Object.hasOwn(raw, key));

const KEYS = ["delegate", "unchangedSince", "fingerprint"];
const FORM = "A prerequisite start is { delegate, unchangedSince, fingerprint }";

class PrerequisiteStartImpl implements Contract.PrerequisiteStart {
  declare readonly __brand: "PrerequisiteStart";
  declare readonly [prerequisiteStartBrand]: true;
  readonly #made = true;
  readonly delegate: AgentName;
  readonly unchangedSince: readonly [string, ...string[]];
  readonly fingerprint: FileSetFingerprint;

  private constructor(fields: RequirementFields) {
    this.delegate = fields.delegate;
    this.unchangedSince = fields.unchangedSince;
    this.fingerprint = fields.fingerprint;
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is PrerequisiteStartImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<Contract.PrerequisiteStart> {
    return readSafely<Contract.PrerequisiteStart>("A prerequisite start", () => {
      const given = PrerequisiteStartImpl.made(raw) ? wireFormOf(raw) : raw;
      if (!hasExactly(given, KEYS)) return refuse(FORM);
      const fields = parseRequirementFields(given, "A prerequisite start");
      return fields.ok ? { ok: true, value: new PrerequisiteStartImpl(fields.value) } : fields;
    });
  }

  static parseList(raw: unknown): Result<readonly Contract.PrerequisiteStart[]> {
    return readSafely<readonly Contract.PrerequisiteStart[]>("The starts kept for a call", () => {
      if (!Array.isArray(raw)) return refuse("The starts kept for a call are a list of prerequisite starts");
      const starts: Contract.PrerequisiteStart[] = [];
      for (const item of raw) {
        const start = PrerequisiteStartImpl.parse(item);
        if (!start.ok) return start;
        starts.push(start.value);
      }
      return { ok: true, value: Object.freeze(starts) };
    });
  }

  requirementKey(): string {
    return requirementKeyOf(this.delegate, this.unchangedSince);
  }

  equals(other: Contract.PrerequisiteStart): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.PrerequisiteStartJSON {
    return { delegate: this.delegate.value, unchangedSince: this.unchangedSince, fingerprint: this.fingerprint.toJSON() };
  }
}

export type PrerequisiteStart = Contract.PrerequisiteStart;
export const PrerequisiteStart: Contract.PrerequisiteStartFactory = PrerequisiteStartImpl;
