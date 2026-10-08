import type { shellCommandReadingBrand } from "./shell-command-reading.contract.ts";
import { own, readSafely, show } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { sameWire, wireFormOf } from "../shared/wire.ts";
import { Effect } from "./effect.ts";
import { ProjectPath } from "./project-path.ts";
import type * as Contract from "./shell-command-reading.contract.ts";

// A shell command reading (ADR 2026-020): one class per outcome. Each `parse`
// is given an object of its outcome's shape (ShellCommandReading.parse checks
// the keys) and reads each field once, own fields only; everything nested is
// checked here, the only way to get a reading, and frozen.

const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });
const FORM = "A shell command reading is { outcome: 'read', programs, fileEffects, unresolved } or { outcome: 'unread', why }";
const LISTS = "A shell command reading's programs, fileEffects and unresolved are lists";
const WORD = "A shell word is { kind: 'literal' or 'unresolved', text }";
const PROGRAM = "A program a shell command runs is { name, arguments, workingDirectory }";
const FILE_EFFECT = "A shell command reading's file effect is { effect, existenceUnknown? }";
const EXISTENCE = "A shell command reading's file effect's existenceUnknown must be true or false";
const PART = "An unresolved part is { text, role }";
const ROLES: readonly Contract.UnresolvedShellRole[] = ["read", "list", "write", "directory", "code"];
const CAUSES: readonly Contract.UnreadShellCommandCause[] = ["too-complex", "unparsable"];
/** Each outcome's fields: a field not listed does not belong, and none may be missing. */
const FIELDS = { read: ["programs", "fileEffects", "unresolved"], unread: ["why"] } as const;

/** A plain object (not a list) whose own keys are exactly `keys`. */
function hasExactly(raw: unknown, keys: readonly string[], optional: readonly string[] = []): raw is object {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const given = Object.keys(raw);
  return keys.every((key) => given.includes(key)) && given.every((key) => keys.includes(key) || optional.includes(key));
}

/** Each entry of a list through `parse`, frozen, or the first entry's refusal. */
function each<T>(raw: readonly unknown[], parse: (entry: unknown) => Result<T>): Result<readonly T[]> {
  const out: T[] = [];
  for (const entry of raw) {
    const parsed = parse(entry);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return { ok: true, value: Object.freeze(out) };
}

function wordOf(raw: unknown): Result<Contract.ShellCommandWord> {
  if (!hasExactly(raw, ["kind", "text"])) return refuse(WORD);
  const kind = own(raw, "kind");
  const text = own(raw, "text");
  if ((kind !== "literal" && kind !== "unresolved") || typeof text !== "string") return refuse(WORD);
  return { ok: true, value: Object.freeze({ kind, text }) };
}

function programOf(raw: unknown): Result<Contract.ShellProgramRun> {
  if (!hasExactly(raw, ["name", "arguments", "workingDirectory"])) return refuse(PROGRAM);
  const name = wordOf(own(raw, "name"));
  if (!name.ok) return name;
  const rawArguments = own(raw, "arguments");
  if (!Array.isArray(rawArguments)) return refuse(PROGRAM);
  const words = each(rawArguments, wordOf);
  if (!words.ok) return words;
  const rawDirectory = own(raw, "workingDirectory");
  if (rawDirectory === null) return { ok: true, value: Object.freeze({ name: name.value, arguments: words.value, workingDirectory: null }) };
  const directory = ProjectPath.parse(rawDirectory);
  return directory.ok ? { ok: true, value: Object.freeze({ name: name.value, arguments: words.value, workingDirectory: directory.value }) } : directory;
}

function fileEffectOf(raw: unknown): Result<Contract.ShellFileEffect> {
  if (!hasExactly(raw, ["effect"], ["existenceUnknown"])) return refuse(FILE_EFFECT);
  const parsed = Effect.parse(own(raw, "effect"));
  if (!parsed.ok) return parsed;
  const effect = parsed.value;
  if (effect.kind !== "read" && effect.kind !== "list" && effect.kind !== "write") return refuse(`A shell command reading's file effects are reads, lists and writes, not '${effect.kind}'`);
  const rawUnknown = own(raw, "existenceUnknown");
  if (rawUnknown !== undefined && typeof rawUnknown !== "boolean") return refuse(EXISTENCE);
  if (rawUnknown !== true) return { ok: true, value: Object.freeze({ effect }) };
  if (effect.kind !== "write" || effect.change === "delete") return refuse("Only a create or a modify can have an unknown existence");
  return { ok: true, value: Object.freeze({ effect, existenceUnknown: true as const }) };
}

function partOf(raw: unknown): Result<Contract.UnresolvedShellPart> {
  if (!hasExactly(raw, ["text", "role"])) return refuse(PART);
  const text = own(raw, "text");
  if (typeof text !== "string" || text === "") return refuse("An unresolved part names the text that could not be resolved");
  const role = ROLES.find((known) => known === own(raw, "role"));
  if (role === undefined) return refuse(`An unresolved part's role is read, list, write, directory or code, not '${show(own(raw, "role"))}'`);
  return { ok: true, value: Object.freeze({ text, role }) };
}

class ReadShellCommandReadingImpl implements Contract.ReadShellCommandReading {
  declare readonly __brand: "ShellCommandReading";
  declare readonly [shellCommandReadingBrand]: true;
  readonly #made = true;
  readonly outcome = "read" as const;

  private constructor(
    readonly programs: readonly Contract.ShellProgramRun[],
    readonly fileEffects: readonly Contract.ShellFileEffect[],
    readonly unresolved: readonly Contract.UnresolvedShellPart[],
  ) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is ReadShellCommandReadingImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: object): Result<Contract.ReadShellCommandReading> {
    const [rawPrograms, rawFileEffects, rawUnresolved] = [own(raw, "programs"), own(raw, "fileEffects"), own(raw, "unresolved")];
    if (!Array.isArray(rawPrograms) || !Array.isArray(rawFileEffects) || !Array.isArray(rawUnresolved)) return refuse(LISTS);
    const programs = each(rawPrograms, programOf);
    if (!programs.ok) return programs;
    const fileEffects = each(rawFileEffects, fileEffectOf);
    if (!fileEffects.ok) return fileEffects;
    const unresolved = each(rawUnresolved, partOf);
    if (!unresolved.ok) return unresolved;
    return { ok: true, value: new ReadShellCommandReadingImpl(programs.value, fileEffects.value, unresolved.value) };
  }

  equals(other: Contract.ShellCommandReading): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.ReadShellCommandReadingJSON {
    return {
      outcome: this.outcome,
      programs: this.programs.map(({ name, arguments: words, workingDirectory }) => ({
        name: { kind: name.kind, text: name.text },
        arguments: words.map(({ kind, text }) => ({ kind, text })),
        workingDirectory: workingDirectory === null ? null : workingDirectory.value,
      })),
      fileEffects: this.fileEffects.map(({ effect, existenceUnknown }) => (existenceUnknown === true ? { effect: effect.toJSON(), existenceUnknown } : { effect: effect.toJSON() })),
      unresolved: this.unresolved.map(({ text, role }) => ({ text, role })),
    };
  }
}

class UnreadShellCommandReadingImpl implements Contract.UnreadShellCommandReading {
  declare readonly __brand: "ShellCommandReading";
  declare readonly [shellCommandReadingBrand]: true;
  readonly #made = true;
  readonly outcome = "unread" as const;

  declare readonly cause?: Contract.UnreadShellCommandCause;

  private constructor(
    readonly why: string,
    cause: Contract.UnreadShellCommandCause | undefined,
  ) {
    if (cause !== undefined) this.cause = cause;
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is UnreadShellCommandReadingImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: object): Result<Contract.UnreadShellCommandReading> {
    const why = own(raw, "why");
    if (typeof why !== "string" || why.trim() === "") return refuse("An unread reading says why it could not be read");
    const rawCause = own(raw, "cause");
    const cause = CAUSES.find((known) => known === rawCause);
    if (rawCause !== undefined && cause === undefined) return refuse(`An unread reading's cause is too-complex or unparsable, not '${show(rawCause)}'`);
    return { ok: true, value: new UnreadShellCommandReadingImpl(why, cause) };
  }

  equals(other: Contract.ShellCommandReading): boolean {
    return sameWire(this, other);
  }

  /** The why and, only when it has one, the cause: readings written before causes existed keep their shape. */
  toJSON(): Contract.UnreadShellCommandReadingJSON {
    return { outcome: this.outcome, why: this.why, ...(this.cause === undefined ? {} : { cause: this.cause }) };
  }
}

function check(raw: unknown): Result<Contract.ShellCommandReading> {
  if (ReadShellCommandReadingImpl.made(raw) || UnreadShellCommandReadingImpl.made(raw)) return check(wireFormOf(raw));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return refuse(FORM);
  const outcome = own(raw, "outcome");
  if (outcome === "read" && hasExactly(raw, ["outcome", ...FIELDS.read])) return ReadShellCommandReadingImpl.parse(raw);
  if (outcome === "unread" && hasExactly(raw, ["outcome", ...FIELDS.unread], ["cause"])) return UnreadShellCommandReadingImpl.parse(raw);
  return refuse(FORM);
}

const parse = (raw: unknown): Result<Contract.ShellCommandReading> => readSafely("A shell command reading", () => check(raw));

export type ShellCommandReading = Contract.ShellCommandReading;
export const ShellCommandReading: Contract.ShellCommandReadingFactory = Object.freeze({ parse });
