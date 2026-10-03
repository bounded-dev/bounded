// bounded gates — every artifact gate, from any shell (ADR 2026-034).
//
//   bounded gates <gate> [cwd] [--json] [flags]
//   bounded gates <gate> --help
//   bounded gates --list [--json]
//
// The gates were already plain functions, but the only way to reach them
// together was a pi session: the trailing verdict line, the cwd rule and two
// of the guard events lived in the extensions. This is the host-independent
// front door. It names no technology: it reads every `packs/<lang>/gates.ts`
// it finds and runs whichever gate the command line names, so a pack adds a
// gate by adding a registry entry and nothing here changes.
//
// Output is the gate's own lines followed by `<gate>: PASS|BLOCK|ERROR`, to
// stdout on a pass and stderr otherwise — the pack CLIs' convention, so a
// person's eye and a CI log filter both keep working. `--json` prints the
// envelope from src/gate-result.ts instead, always to stdout. Exit codes are
// the contract's: 0 PASS · 1 BLOCK · 2 ERROR (the gate could not run) · 64
// usage (this program was misused, no gate ran).
//
// The CLI does not decide who may run a gate: that is a capability constraint
// and belongs to the host's adapter (the path gate in pi). From a bare shell
// every gate is runnable and the log says so by what it does not record.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  argString,
  isGateRegistry,
  parseGateArgs,
  type FlagSpec,
  type GateArgs,
  type GateCommand,
} from "./gate-command.ts";
import { gateEnvelope, gateError, gateExitCode, verdictLine, type GateResult } from "./gate-result.ts";
import { logGuardEvent } from "./guard-log.ts";
import { HOST_ENV, NO_HOST, hostFromEnv, recordHostDeclaration, type HostName } from "./host.ts";
import { isMainModule } from "./is-main-module.ts";
import { asRole } from "./path-gate.ts";
import { targetCwd } from "./target-cwd.ts";

/** sysexits' EX_USAGE: the program was invoked wrongly, no gate ran. */
export const USAGE_EXIT = 64;

const PROGRAM = "bounded gates";
/** The env var a host adapter sets so the CLI runs as the bound role (src/path-gate.ts). */
const ROLE_ENV = "BOUNDED_DEV_STAGE_ROLE";

/**
 * The args the environment supplies: a gate with a `role` flag that was not
 * given one on the command line takes the role a host adapter (or a person)
 * exported, if it names a pipeline role. The gate itself never resolves a
 * role — it would resolve it against the TARGET directory, which is how
 * `typecheck src` came back unscoped in Run 15.
 */
export function envArgs(gate: GateCommand, args: GateArgs, env: Readonly<Record<string, string | undefined>>): GateArgs {
  if (!gate.flags.some((f) => f.name === "role") || argString(args, "role") !== undefined) return args;
  const role = asRole(env[ROLE_ENV]);
  return role === undefined ? args : { ...args, role };
}

/** Flags the CLI itself owns, accepted before or after the gate name. */
const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "json", kind: "boolean", description: "Print one JSON object instead of lines and a verdict." },
  { name: "help", kind: "boolean", description: "Show this help." },
  { name: "list", kind: "boolean", description: "List every gate (with --json: as an array)." },
];

// --- discovery -----------------------------------------------------------------------

/** Where the packs live, resolved from this file so the CLI works through the
 *  ~/.pi/agent symlink and from any cwd. */
export function packsDir(): string {
  return fileURLToPath(new URL("../packs/", import.meta.url));
}

/**
 * Every gate every pack contributes, in pack order. A `gates.ts` whose export
 * is not a registry is an error, not a skip: a pack that half-loads is a gate
 * that silently cannot be run.
 */
export async function discoverGates(dir: string = packsDir()): Promise<readonly GateCommand[]> {
  const found: GateCommand[] = [];
  const packs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const pack of packs) {
    const registry = join(dir, pack, "gates.ts");
    if (!existsSync(registry)) continue;
    const mod: unknown = await import(pathToFileURL(registry).href);
    const gates = typeof mod === "object" && mod !== null && "gates" in mod ? mod.gates : undefined;
    if (!isGateRegistry(gates)) throw new Error(`${registry}: the 'gates' export is not a gate registry`);
    found.push(...gates);
  }
  return found;
}

// --- help text ----------------------------------------------------------------------

/** The first sentence of a description — enough for a listing. */
function firstSentence(text: string): string {
  const m = /^.*?[.!?](?=\s|$)/.exec(text);
  return m === null ? text : m[0];
}

function flagUsage(flag: FlagSpec): string {
  const value = flag.kind === "boolean" ? "" : ` <${flag.kind}>`;
  const repeat = flag.repeatable ? " (repeatable)" : "";
  return `--${flag.name}${value}${repeat}`;
}

function table(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(0, ...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`);
}

/** The top-level usage: every gate, one line each. */
export function usage(gates: readonly GateCommand[]): string {
  return [
    `usage: ${PROGRAM} <gate> [cwd] [--json] [flags]`,
    `       ${PROGRAM} <gate> --help`,
    `       ${PROGRAM} --list [--json]`,
    "",
    "Run one artifact gate against a project (default: the current directory).",
    "Prints the gate's lines and a final `<gate>: PASS|BLOCK|ERROR` line;",
    "--json prints one JSON object instead.",
    "",
    "exit codes: 0 PASS · 1 BLOCK · 2 ERROR (the gate could not run) · 64 usage",
    "",
    "gates:",
    ...table(gates.map((g) => [g.name, firstSentence(g.description)])),
    "",
  ].join("\n");
}

/** What a gate's usage depends on beyond the gate: the host that named
 *  itself to this process, if any (`BOUNDED_HOST`). */
export interface UsageContext {
  readonly host?: HostName | undefined;
}

/**
 * One gate's usage: the whole description and its flags, each followed by
 * its example when it has one. Under a named host the command-line-only
 * flags are left out: a host runs a gate the way its tool does, and its
 * adapter refuses them (the Claude Code bash policy does), so offering them
 * there only costs a refused call. A bare shell lists every flag.
 */
export function gateUsage(gate: GateCommand, context: UsageContext = {}): string {
  const offered = context.host === undefined ? gate.flags : gate.flags.filter((f) => f.cliOnly !== true);
  const flags = [...offered, ...GLOBAL_FLAGS.filter((f) => f.name === "json")];
  const width = Math.max(0, ...flags.map((f) => flagUsage(f).length));
  const lines = flags.flatMap((f) => {
    const line = `  ${flagUsage(f).padEnd(width)}  ${f.description}`;
    return f.example === undefined ? [line] : [line, `  ${" ".repeat(width)}  example: ${f.example}`];
  });
  return [
    `usage: ${PROGRAM} ${gate.name} [cwd] [--json]${offered.length > 0 ? " [flags]" : ""}`,
    "",
    gate.description,
    "",
    "flags:",
    ...lines,
    "",
  ].join("\n");
}

/** The `--list --json` rows. */
export function listing(gates: readonly GateCommand[]): readonly Record<string, unknown>[] {
  return gates.map((g) => ({ name: g.name, tool: g.tool ?? null, description: g.description, flags: g.flags }));
}

// --- the command line ------------------------------------------------------------------

export interface Output {
  out(text: string): void;
  err(text: string): void;
}

const STDIO: Output = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** Print a result the way the pack CLIs do: lines then the verdict line, on
 *  stdout for a pass and stderr otherwise; or the JSON envelope on stdout. */
function print(io: Output, name: string, result: GateResult, json: boolean): void {
  if (json) {
    io.out(`${JSON.stringify(gateEnvelope(name, result))}\n`);
    return;
  }
  const text = [...result.lines, verdictLine(name, result.code)].join("\n") + "\n";
  (result.code === 0 ? io.out : io.err)(text);
}

/**
 * Run the command line and return the exit code. `sessionCwd` is what a
 * relative `[cwd]` resolves against; `io` is where output goes. Both are
 * parameters so a test can drive this without spawning, though the tests
 * spawn too — the launcher is part of the contract.
 */
export async function main(
  argv: readonly string[],
  sessionCwd: string = process.cwd(),
  io: Output = STDIO,
  gates?: readonly GateCommand[],
): Promise<number> {
  const all = gates ?? (await discoverGates());

  // `--list` anywhere means list: it names no gate, so no gate runs.
  if (argv.includes("--list")) {
    io.out(argv.includes("--json") ? `${JSON.stringify(listing(all))}\n` : usage(all));
    return 0;
  }

  // The gate name is the first token that is not one of the CLI's own flags;
  // anything after it is parsed against that gate's spec.
  let json = false;
  let help = false;
  let name: string | undefined;
  const rest: string[] = [];
  for (const token of argv) {
    if (name !== undefined) {
      rest.push(token);
    } else if (token === "--json") {
      json = true;
    } else if (token === "--help") {
      help = true;
    } else if (token.startsWith("--")) {
      io.err(`${PROGRAM}: unknown flag ${token}\n\n${usage(all)}`);
      return USAGE_EXIT;
    } else {
      name = token;
    }
  }

  if (name === undefined) {
    (help ? io.out : io.err)(usage(all));
    return help ? 0 : USAGE_EXIT;
  }
  const gate = all.find((g) => g.name === name);
  if (gate === undefined) {
    io.err(`${PROGRAM}: unknown gate '${name}'\n\n${usage(all)}`);
    return USAGE_EXIT;
  }

  const usageContext: UsageContext = { host: hostFromEnv(process.env[HOST_ENV]) };
  const parsed = parseGateArgs([...gate.flags, ...GLOBAL_FLAGS], rest);
  if (!parsed.ok) {
    io.err(`${PROGRAM} ${gate.name}: ${parsed.error}\n\n${gateUsage(gate, usageContext)}`);
    return USAGE_EXIT;
  }
  json = json || parsed.args["json"] === true;
  help = help || parsed.args["help"] === true;
  if (help) {
    io.out(gateUsage(gate, usageContext));
    return 0;
  }
  if (parsed.positionals.length > 1) {
    io.err(`${PROGRAM} ${gate.name}: expected at most one positional (the project directory), got ${parsed.positionals.length}\n\n${gateUsage(gate, usageContext)}`);
    return USAGE_EXIT;
  }
  const cwd = targetCwd(sessionCwd, parsed.positionals[0]);

  // A bare shell enforces no capability constraint, and the log must say so
  // (ADR 2026-034) — unless a host adapter NAMED itself to this process, in
  // which case it declared itself before the call reached here. A role alone
  // is not a host: a person exports BOUNDED_DEV_STAGE_ROLE to see a role's view.
  if (hostFromEnv(process.env[HOST_ENV]) === undefined) recordHostDeclaration(cwd, NO_HOST);

  let result: GateResult;
  try {
    result = await gate.run(cwd, envArgs(gate, parsed.args, process.env));
  } catch (e) {
    // A gate that throws could not run: ERROR, in the same shape as any
    // other, so a --json consumer never has to parse a stack trace — and
    // logged, because a gate that ran and threw is still a gate that did
    // not pass.
    result = gateError(gate.name, e instanceof Error ? e.message : String(e), "threw");
    logGuardEvent(cwd, { guard: gate.name, verdict: "error", summary: result.summary, detail: result.detail });
  }
  print(io, gate.name, result, json);
  return gateExitCode(result);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`${PROGRAM}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
