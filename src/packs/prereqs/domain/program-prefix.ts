import type { programPrefixBrand } from "./program-prefix.contract.ts";
import { type Result, readSafely, type ShellCommandReading, type ShellProgramRun, sameWire, wireFormOf } from "bounded/domain";
import type * as Contract from "./program-prefix.contract.ts";

const ERROR = "A rule's before.execute is a program and its leading arguments as the program receives them, separated by spaces: ";
const MAX_LENGTH = 1000;
const MAX_WORDS = 16;
/** Characters the shell reads rather than passes on to the program. */
const SHELL_SYNTAX = new Set([..."'\"\\$*?[]{}()<>|;&#`"]);
/** Words of the shell's own grammar, never a program's name. */
const RESERVED = new Set(["!", "time", "if", "then", "else", "elif", "fi", "case", "esac", "for", "select", "while", "until", "do", "done", "in", "function", "coproc", "[[", "]]"]);
const refuse = (why: string): { ok: false; error: string } => ({ ok: false, error: `${ERROR}${why}` });
const isControl = (c: string): boolean => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f || (c.charCodeAt(0) >= 0x80 && c.charCodeAt(0) < 0xa0);

/** A prefix's fields once checked. */
interface Fields {
  readonly program: string;
  readonly leadingArguments: readonly string[];
}

function check(raw: unknown): Result<Fields> {
  if (typeof raw !== "string") return refuse("it is not text");
  const words = raw.split(" ").filter((word) => word !== "");
  if (words.length === 0) return refuse("it is empty");
  if ([...raw].some((c) => c !== " " && /\s/.test(c))) return refuse("it holds whitespace other than a space");
  if ([...raw].some(isControl)) return refuse("it holds a control character");
  const tidy = words.join(" ");
  if (tidy.length > MAX_LENGTH) return refuse(`it is longer than ${MAX_LENGTH} characters`);
  if (words.length > MAX_WORDS) return refuse(`it has more than ${MAX_WORDS} words`);
  const syntax = [...tidy].find((c) => SHELL_SYNTAX.has(c));
  if (syntax !== undefined) return refuse(`it holds '${syntax}', which the shell would read, not pass on`);
  const [program = "", ...leadingArguments] = words;
  if (program.includes("~")) return refuse("the program holds '~', which the shell expands to a home directory");
  if (program.includes("/")) return refuse(`the program is named by itself, not by a path ('${program}')`);
  if (program.includes("=")) return refuse("the program holds '=', so the shell would read the word as an assignment, not a program");
  if (RESERVED.has(program)) return refuse(`'${program}' is a word of the shell's own grammar, not a program`);
  if (program.startsWith("-")) return refuse("the program starts with '-', so it is an option, not a program");
  const home = leadingArguments.find((word) => word.startsWith("~"));
  if (home !== undefined) return refuse(`'${home}' starts with '~', which the shell expands to a home directory`);
  const option = leadingArguments.find((word) => word.startsWith("-"));
  if (option !== undefined) return refuse(`'${option}' starts with '-': a rule names its program and subcommand words, never an option`);
  return { ok: true, value: { program, leadingArguments: Object.freeze(leadingArguments) } };
}

/** A name as the program it runs: its last path segment, case folded. */
const programName = (text: string): string => (text.split("/").at(-1) ?? text).toLowerCase();

/**
 * Whether an argument's text, as written or literal, names `program` (case
 * folded) anywhere it could stand: its quote and backslash characters
 * deleted, then split at every character that cannot be part of a
 * program's name or path (anything but letters, digits, '.', '_', '+', '-'
 * and '/'), each piece compared by its last path segment. So
 * `cd infra;terraform apply`, `"terraform" apply` and
 * `"terraform apply $X"` name terraform; `terraform-docs` does not.
 */
const namesProgram = (text: string, program: string): boolean => {
  const bare = text.replace(/["'\\]/g, "");
  // A program whose name holds another character (make@2) is looked for anywhere in the text: over-matching only fails closed.
  if (/[^a-z0-9._+-]/.test(program)) return bare.toLowerCase().includes(program);
  return bare.split(/[^A-Za-z0-9._+\-/]+/).some((piece) => piece !== "" && programName(piece) === program);
};

/** One way of reading a run's arguments so far: how many of the prefix's words are found, whether `--` ended the options, and whether the next word is an option's value. */
interface Reading {
  readonly found: number;
  readonly optionsEnded: boolean;
  readonly valueNext: boolean;
}

/** What one run of the prefix's program makes of its words: found, cannot be seen (the unresolved word, and the word not yet found), or not. */
type WordsMatch = { readonly kind: "found" } | { readonly kind: "unresolved"; readonly text: string; readonly awaited: string } | { readonly kind: "not-found" };

/**
 * Whether `run`'s arguments give `words` first, reading options every
 * plausible way: a literal option word (starting with '-', not '-' alone,
 * before any '--') is skipped, and one without '=' may take the next word as
 * its value; '--' ends the options. Any unresolved argument reached while a
 * word is still to be found cannot be seen. One pass, keeping each reading
 * still possible (at most 4 per word).
 */
function wordsOf(run: ShellProgramRun, words: readonly string[]): WordsMatch {
  if (words.length === 0) return { kind: "found" };
  let readings: Reading[] = [{ found: 0, optionsEnded: false, valueNext: false }];
  for (const argument of run.arguments) {
    if (readings.length === 0) return { kind: "not-found" };
    if (argument.kind === "unresolved") {
      const awaited = Math.min(...readings.map((reading) => reading.found));
      return { kind: "unresolved", text: argument.text, awaited: words[awaited] ?? "" };
    }
    const text = argument.text;
    const next = new Map<string, Reading>();
    const add = (reading: Reading): void => {
      next.set(`${reading.found}/${reading.optionsEnded}/${reading.valueNext}`, reading);
    };
    for (const reading of readings) {
      if (reading.valueNext) {
        add({ ...reading, valueNext: false });
        continue;
      }
      if (text === words[reading.found]) {
        if (reading.found + 1 === words.length) return { kind: "found" };
        add({ ...reading, found: reading.found + 1 });
      }
      if (reading.optionsEnded) continue;
      if (text === "--") add({ ...reading, optionsEnded: true });
      else if (text.startsWith("-") && text !== "-") {
        add(reading);
        if (!text.includes("=")) add({ ...reading, valueNext: true });
      }
    }
    readings = [...next.values()];
  }
  return { kind: "not-found" };
}

class ProgramPrefixImpl implements Contract.ProgramPrefix {
  declare readonly __brand: "ProgramPrefix";
  declare readonly [programPrefixBrand]: true;
  readonly #made = true;
  readonly program: string;
  readonly leadingArguments: readonly string[];

  private constructor(program: string, leadingArguments: readonly string[]) {
    this.program = program;
    this.leadingArguments = leadingArguments;
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is ProgramPrefixImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<Contract.ProgramPrefix> {
    return readSafely<Contract.ProgramPrefix>("A program prefix", () => {
      const fields = check(ProgramPrefixImpl.made(raw) ? wireFormOf(raw) : raw);
      return fields.ok ? { ok: true, value: new ProgramPrefixImpl(fields.value.program, fields.value.leadingArguments) } : fields;
    });
  }

  matchIn(reading: ShellCommandReading): Contract.ProgramPrefixMatch {
    if (reading.outcome === "unread") return { kind: "cannot-see", why: `the command could not be read (${reading.why})`, fix: reading.cause === "too-complex" ? "simplify" : "reinstall" };
    const program = this.program.toLowerCase();
    const ofProgram = reading.programs.filter((run) => run.name.kind === "literal" && programName(run.name.text) === program);
    const matches = ofProgram.map((run) => ({ run, words: wordsOf(run, this.leadingArguments) }));
    const runs = matches.find(({ words }) => words.kind === "found");
    if (runs !== undefined) return { kind: "runs", run: runs.run };
    const unresolvedName = reading.programs.find((run) => run.name.kind === "unresolved");
    if (unresolvedName !== undefined) return { kind: "cannot-see", why: `it runs a program whose name only the shell can resolve ('${unresolvedName.name.text}')`, fix: "readable" };
    for (const { run, words } of matches) {
      if (words.kind === "unresolved") {
        return { kind: "cannot-see", why: `'${words.text}', which only the shell can resolve, stands before ${run.name.text}'s argument '${words.awaited}' could be found`, fix: "readable" };
      }
    }
    const code = reading.unresolved.find((part) => part.role === "code");
    if (code !== undefined) return { kind: "cannot-see", why: `it runs code bounded cannot read ('${code.text}')`, fix: "none" };
    for (const run of reading.programs) {
      const passed = run.arguments.find((argument) => namesProgram(argument.text, program));
      if (passed !== undefined) return { kind: "cannot-see", why: `it passes '${passed.text}' to ${run.name.text}, which may run ${this.program}`, fix: "none" };
    }
    return { kind: "does-not-run" };
  }

  equals(other: Contract.ProgramPrefix): boolean {
    return sameWire(this, other);
  }

  toJSON(): string {
    return [this.program, ...this.leadingArguments].join(" ");
  }
}

export type ProgramPrefix = Contract.ProgramPrefix;
export const ProgramPrefix: Contract.ProgramPrefixFactory = ProgramPrefixImpl;
