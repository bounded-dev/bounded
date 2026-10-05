// Gate command — how a pack declares a gate to the root (ADR 2026-034).
//
// The root names no technology: it discovers `packs/<lang>/gates.ts` by
// convention and reads a list of these. One entry carries everything BOTH
// hosts need — the CLI its name and flags, the pi extension its tool name,
// description and prompt guidance — so a gate's public face is written once
// and neither host can drift from the other. The `run` is the same function
// the pack's own script calls from `main`, so a gate cannot differ by how it
// was invoked.
//
// Also here: the flag grammar. A FlagSpec is the CLI's schema the way a
// TypeBox object is the tool's, and parsing it is a pure function so the
// registry tests can assert what an invocation means without spawning.

import type { GateResult } from "./gate-result.ts";

export type FlagKind = "boolean" | "string" | "number" | "json";

export interface FlagSpec {
  /** Long name, without the leading dashes: `pattern` is `--pattern`. */
  readonly name: string;
  readonly kind: FlagKind;
  /** May be given more than once; the parsed value is then a list. */
  readonly repeatable?: boolean;
  readonly description: string;
  /** The tool-parameter name when it differs from the flag name: the
   *  repeatable `--pattern` is the tool's `patterns`, `--max-mutants` its
   *  `maxMutants`. Absent, the parameter is named after the flag. */
  readonly param?: string;
  /** A flag no host exposes as a tool parameter, only the command line
   *  accepts: a model passes findings inline, never by file; a role never
   *  chooses its own scoping. */
  readonly cliOnly?: true;
  /** The tool parameter is required. The CLI cannot say so (an alternative
   *  flag may stand in — `--findings-file` for `--findings`), so `run`
   *  enforces it there and reports misuse. */
  readonly required?: true;
  /** For a `json` flag: the plain JSON Schema the model should see, complete
   *  with its descriptions. Host-agnostic — a host converts it to whatever
   *  schema type its tool API takes. */
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
  /** An example value, as the JSON text a person would type: a host's help
   *  prints it under the flag, so the shape a gate accepts is shown where
   *  the flag is offered. Data the pack supplies; the core never reads it. */
  readonly example?: string;
}

/** Parsed flags, by name. A boolean is `true` when given; a repeatable flag is
 *  a list; a `json` flag is whatever it parsed to. Read through the `arg*`
 *  accessors below rather than by hand. */
export type GateArgs = Readonly<Record<string, unknown>>;

/** A point in a ticket's delivery that a gate's pass marks, which the board
 *  follows (src/board-sync.ts, ADR 2026-066). Packs tag their gates; the core
 *  names no gate. */
export type GateMilestone = "design-frozen" | "delivered" | "handoff-published";
export const GATE_MILESTONES: readonly GateMilestone[] = ["design-frozen", "delivered", "handoff-published"];

/** A gate whose run can outlast a host's command limit (ADR 2026-073). Under
 *  a host deadline the core runs it as a background job and answers RUNNING
 *  until a later call collects its verdict. `reads-tree`: the run only judges
 *  the tree, so a tree that changed while it ran voids it. `writes-tree`: the
 *  run changes the tree itself (delivery), and is judged over the tree it left. */
export type LongRunning = "reads-tree" | "writes-tree";
export const LONG_RUNNING: readonly LongRunning[] = ["reads-tree", "writes-tree"];

export interface GateCommand {
  /** The CLI name: `bounded gates <name>`. Also the prefix of the verdict line. */
  readonly name: string;
  /** The delivery milestone this gate's pass marks, if any. */
  readonly milestone?: GateMilestone;
  /** The pi tool name, when the gate is exposed as one. Absent for a gate that
   *  is CLI-only: a step of a composite (scaffold) or a check the delivered
   *  project runs on its own (surface-check). */
  readonly tool?: string;
  /** The tool description — verbatim what the model reads. */
  readonly description: string;
  readonly flags: readonly FlagSpec[];
  /** One line for a host's tool roster — pi's "Available tools" section. */
  readonly promptSnippet?: string;
  /** Prompt guidance a host may fold into the role's brief. */
  readonly promptGuidelines?: readonly string[];
  /** Run as a background job under a host deadline (ADR 2026-073). */
  readonly longRunning?: LongRunning;
  /**
   * A step before the run whose own effects are not part of what the run is
   * judged on (a pack putting back what an earlier, killed run left). A
   * result from it ends the call with that result. A background job takes the
   * tree it judges after this step, so the step's own edits never read as the
   * tree changing under the run.
   */
  prepare?(cwd: string): Promise<GateResult | undefined>;
  run(cwd: string, args: GateArgs): Promise<GateResult>;
}

// --- runtime shape checks (the registry arrives through a dynamic import) ------

function isFlagSpec(x: unknown): x is FlagSpec {
  if (typeof x !== "object" || x === null) return false;
  const f: Record<string, unknown> = { ...x };
  return (
    typeof f["name"] === "string" &&
    (f["kind"] === "boolean" || f["kind"] === "string" || f["kind"] === "number" || f["kind"] === "json") &&
    (f["repeatable"] === undefined || typeof f["repeatable"] === "boolean") &&
    typeof f["description"] === "string" &&
    (f["param"] === undefined || typeof f["param"] === "string") &&
    (f["cliOnly"] === undefined || f["cliOnly"] === true) &&
    (f["required"] === undefined || f["required"] === true) &&
    (f["jsonSchema"] === undefined || (typeof f["jsonSchema"] === "object" && f["jsonSchema"] !== null)) &&
    (f["example"] === undefined || typeof f["example"] === "string")
  );
}

export function isGateCommand(x: unknown): x is GateCommand {
  if (typeof x !== "object" || x === null) return false;
  const c: Record<string, unknown> = { ...x };
  return (
    typeof c["name"] === "string" &&
    (c["milestone"] === undefined || (GATE_MILESTONES as readonly unknown[]).includes(c["milestone"])) &&
    (c["tool"] === undefined || typeof c["tool"] === "string") &&
    typeof c["description"] === "string" &&
    Array.isArray(c["flags"]) &&
    c["flags"].every(isFlagSpec) &&
    (c["promptSnippet"] === undefined || typeof c["promptSnippet"] === "string") &&
    (c["promptGuidelines"] === undefined ||
      (Array.isArray(c["promptGuidelines"]) && c["promptGuidelines"].every((g) => typeof g === "string"))) &&
    (c["longRunning"] === undefined || (LONG_RUNNING as readonly unknown[]).includes(c["longRunning"])) &&
    (c["prepare"] === undefined || typeof c["prepare"] === "function") &&
    typeof c["run"] === "function"
  );
}

/** Is `x` the `gates` export of a pack registry? */
export function isGateRegistry(x: unknown): x is readonly GateCommand[] {
  return Array.isArray(x) && x.every(isGateCommand);
}

// --- flag parsing ----------------------------------------------------------------

export type ParsedArgs =
  | { readonly ok: true; readonly args: GateArgs; readonly positionals: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** One flag's value, parsed by its kind; a string is the error to report. */
function parseValue(spec: FlagSpec, raw: string): { readonly value: unknown } | { readonly error: string } {
  switch (spec.kind) {
    case "string":
      return { value: raw };
    case "number": {
      const n = Number(raw);
      return raw.trim() === "" || !Number.isFinite(n)
        ? { error: `--${spec.name} needs a number (got '${raw}')` }
        : { value: n };
    }
    case "json":
      try {
        return { value: JSON.parse(raw) };
      } catch {
        return { error: `--${spec.name} is not valid JSON` };
      }
    case "boolean":
      return { error: `--${spec.name} takes no value` };
  }
}

/**
 * Parse `argv` against `specs`. `--name value` and `--name=value` both work;
 * a boolean flag stands alone. Anything not starting with `--` is a
 * positional. Strict on purpose: an unknown flag, a missing value, a repeated
 * non-repeatable flag or a malformed value is an error, never a guess — the
 * caller turns it into usage (exit 64).
 */
export function parseGateArgs(specs: readonly FlagSpec[], argv: readonly string[]): ParsedArgs {
  const byName = new Map(specs.map((s) => [s.name, s]));
  const args: Record<string, unknown> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const spec = byName.get(name);
    if (spec === undefined) return { ok: false, error: `unknown flag --${name}` };

    if (spec.kind === "boolean") {
      if (eq !== -1) return { ok: false, error: `--${name} takes no value` };
      args[name] = true;
      continue;
    }

    const raw = eq === -1 ? argv[++i] : token.slice(eq + 1);
    if (raw === undefined) return { ok: false, error: `--${name} needs a value` };
    const parsed = parseValue(spec, raw);
    if ("error" in parsed) return { ok: false, error: parsed.error };

    if (spec.repeatable) {
      const prior = args[name];
      args[name] = Array.isArray(prior) ? [...prior, parsed.value] : [parsed.value];
    } else if (name in args) {
      return { ok: false, error: `--${name} given more than once` };
    } else {
      args[name] = parsed.value;
    }
  }
  return { ok: true, args, positionals };
}

// --- typed access ---------------------------------------------------------------
// The parser guarantees the shape per kind; these just narrow it for a `run`.

export function argBoolean(args: GateArgs, name: string): boolean {
  return args[name] === true;
}

export function argString(args: GateArgs, name: string): string | undefined {
  const v = args[name];
  return typeof v === "string" ? v : undefined;
}

export function argNumber(args: GateArgs, name: string): number | undefined {
  const v = args[name];
  return typeof v === "number" ? v : undefined;
}

/** A repeatable string flag's values, `[]` when it was not given. */
export function argStrings(args: GateArgs, name: string): readonly string[] {
  const v = args[name];
  if (typeof v === "string") return [v];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** A json flag's parsed value; `undefined` when it was not given (a given
 *  `null` is preserved — the parse happened). */
export function argJson(args: GateArgs, name: string): unknown {
  return name in args ? args[name] : undefined;
}
