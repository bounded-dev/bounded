// Bash policy for the Claude Code host (ADR 2026-034).
//
// In pi no role holds a shell: the gates, git and sleep are NAMED tools, and
// `bash` is in every role's FORBIDDEN_TOOLS. Claude Code has no way to add a
// named tool to a subagent, so the gates are reached the one way they can be —
// `bounded gates <gate>` through Bash — and Bash becomes the thing this file
// narrows: a role may run exactly the commands that stand in for the pi tools
// its ROLE_TOOLS entry names, and nothing else. One list, derived, never a
// second: the set of gates a role may invoke here IS its ROLE_TOOLS minus the
// tools that have a Claude Code tool or a bash carrier of their own.
//
// The narrowing is deliberately stricter than "is the first word allowed".
// A shell string is a program, and `bounded gates typecheck; cat <a test file>`
// starts with an allowed word. No role holds a content-bearing shell tool
// (cat, grep, head, sed …): a test file's content reaches the builder through
// nothing, and an implementation's reaches the test-writer through nothing.
// `ls` and `find` are here only as names-only listings (listing.ts), judged as
// pi's own `ls` and `find`. So the command is first read the way a POSIX
// shell would, quote by quote, and refused the moment it uses anything that
// would make it more than one plain argv: separators, pipes, redirects,
// substitutions, globs, brace and tilde expansion, backslash escapes, an env
// assignment prefix. What survives is a single argv the shell will pass
// verbatim, and THAT is judged. A refusal says which construct and which
// commands this role may run instead, because a refused command costs a turn
// and a vague refusal costs several.
//
// An allowed `bounded gates` call is also where the bound role and the host cross
// into the CLI process: the hook rewrites the command with a
// `BOUNDED_HOST=claude-code BOUNDED_DEV_STAGE_ROLE=<role>` prefix (`updatedInput`).
// `sessionRole()` reads the role before the role file, so a role-scoped gate
// view (typecheck) sees the role the definition bound rather than whatever
// file the project holds, and the CLI records which host ran it. This module
// only refuses the model's own attempts at the same thing — an env prefix it
// typed, of either name, a `--role` it passed — and reports the carrier, so
// the hook knows which allow to decorate. Pure: no fs, no process, no
// logging. The hook logs.

import { PIPELINE_ROLES } from "../../src/path-gate.ts";
import { gitPolicy } from "../../src/git-policy.ts";
import {
  ARTIFACT_GATE_TOOLS,
  decide,
  forbiddenWhy,
  ROLE_TOOLS,
  type Ctx,
  type Decision,
  type Role,
} from "../../src/path-policy.ts";
import { isSleepSeconds, SLEEP_MAX_SECONDS, SLEEP_MIN_SECONDS } from "../../src/sleep-bounds.ts";
import { gateInputs, listingCall } from "./listing.ts";
import { searchPatternContained } from "../../src/setup-state.ts";

/** Which sanctioned carrier an allowed command is. The hook needs to know:
 *  a `bounded gates` call is handed the bound role through `updatedInput`, the
 *  other carriers are let through untouched. */
export type Carrier = "bounded gates" | "git" | "sleep" | "rm" | "ls" | "find";

/** A Decision that, when it allows, also says which carrier it allowed. */
export type BashDecision =
  | { readonly allow: true; readonly carrier: Carrier }
  | { readonly allow: false; readonly reason: string };

const allow = (carrier: Carrier): BashDecision => ({ allow: true, carrier });
const block = (reason: string): BashDecision => ({ allow: false, reason });

/**
 * The pi tools reached through `bounded gates`: exactly ARTIFACT_GATE_TOOLS
 * (src/path-policy.ts). Everything else in a role's ROLE_TOOLS is a host
 * capability — the file tools have a Claude Code tool of their own (see
 * render-agents.ts), and `remove`, `git` and `sleep` have their own bash
 * carriers below. Derived, so a new gate in the registry is a CLI gate here
 * without a second list to update.
 */
const CLI_GATE_TOOLS: ReadonlySet<string> = new Set(ARTIFACT_GATE_TOOLS);

/** The pi tool names a role reaches through `bounded gates <gate>`. */
export function cliGates(role: Role): readonly string[] {
  return ROLE_TOOLS[role].filter((tool) => CLI_GATE_TOOLS.has(tool));
}

/** Every gate any role holds — the CLI's vocabulary, for "no such gate". */
const ALL_GATES: ReadonlySet<string> = new Set(PIPELINE_ROLES.flatMap((role) => cliGates(role)));

/** The CLI spelling of a pi tool: `red_gate` → `red-gate`. */
export function gateCommand(tool: string): string {
  return tool.replace(/_/g, "-");
}

/** The pi tool a CLI argument names: `red-gate` → `red_gate`. Both spellings
 *  are accepted on the way in so a model that read the pi brief and one that
 *  read `bounded gates --list` are both right. */
function gateTool(arg: string): string {
  return arg.replace(/-/g, "_");
}

/** What this role may put through Bash — the tail of every refusal. */
export function carriers(role: Role): string {
  const tools = ROLE_TOOLS[role];
  const out = ["bounded gates <gate>"];
  if (tools.includes("git")) out.push("git …");
  if (tools.includes("sleep")) out.push(`sleep <${SLEEP_MIN_SECONDS}-${SLEEP_MAX_SECONDS}>`);
  if (tools.includes("remove")) out.push("rm <path>");
  if (tools.includes("ls")) out.push("ls [<dir>]");
  if (tools.includes("find")) out.push("find <dir> -name '<glob>'");
  return out.join(", ");
}

// --- Reading the command the way the shell will -----------------------------

type Words = { readonly ok: true; readonly argv: readonly string[] } | { readonly ok: false; readonly reason: string };

/** Constructs refused outside quotes, with the name a refusal uses. */
const UNQUOTED_META: ReadonlyMap<string, string> = new Map([
  [";", "a command separator (';')"],
  ["&", "a background/and operator ('&')"],
  ["|", "a pipe ('|')"],
  ["(", "a subshell ('(')"],
  [")", "a subshell (')')"],
  ["<", "a redirect ('<')"],
  [">", "a redirect ('>')"],
  ["\n", "a newline"],
  ["\r", "a newline"],
  ["$", "a substitution ('$')"],
  ["`", "a substitution ('`')"],
  ["\\", "a backslash escape"],
  ["*", "a glob ('*')"],
  ["?", "a glob ('?')"],
  ["[", "a glob ('[')"],
  ["{", "a brace expansion ('{')"],
  ["!", "history expansion ('!')"],
]);

/** Refused only at the start of a word: `~/x` expands, `HEAD~3` is a ref. */
const TILDE = "a tilde expansion ('~')";

/** Inside double quotes the shell still expands these. */
const DOUBLE_QUOTED_META: ReadonlyMap<string, string> = new Map([
  ["$", "a substitution ('$') inside double quotes"],
  ["`", "a substitution ('`') inside double quotes"],
  ["\\", "a backslash escape inside double quotes"],
]);

/**
 * Split a command into the argv a POSIX shell would pass, or say why it
 * cannot be read as one plain command. Single quotes are literal throughout;
 * double quotes are literal except for the three expansions above, which are
 * refused rather than modelled.
 */
export function shellWords(command: string): Words {
  const argv: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;
  for (const ch of command) {
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      const why = DOUBLE_QUOTED_META.get(ch);
      if (why !== undefined) return { ok: false, reason: why };
      if (ch === '"') quote = undefined;
      else word += ch;
      continue;
    }
    const why = UNQUOTED_META.get(ch);
    if (why !== undefined) return { ok: false, reason: why };
    if (ch === "#" && !inWord) return { ok: false, reason: "a comment ('#')" };
    if (ch === "~" && !inWord) return { ok: false, reason: TILDE };
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (inWord) argv.push(word);
      word = "";
      inWord = false;
      continue;
    }
    word += ch;
    inWord = true;
  }
  if (quote !== undefined) return { ok: false, reason: "an unterminated quote" };
  if (inWord) argv.push(word);
  return { ok: true, argv };
}

// --- The carriers -------------------------------------------------------------

/** git subcommands whose job is to run another program. */
const GIT_RUNS_PROGRAMS: ReadonlySet<string> = new Set([
  "filter-branch",
  "difftool",
  "mergetool",
  "instaweb",
  "citool",
  "gui",
  "web--browse",
]);

/** `git config` reads that are only reads. */
const GIT_CONFIG_READS: ReadonlySet<string> = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--list",
  "-l",
  "--show-origin",
  "--show-scope",
]);

/** The only global options allowed BEFORE the subcommand. Every other one is
 *  refused unseen, because a global that takes a value (`-C <dir>`,
 *  `--git-dir <dir>`, `--work-tree`, `--namespace`, …) puts its value where
 *  the subcommand is looked for, and `git -C . config core.hooksPath x` would
 *  read as the subcommand `.` — past every check below. None of these four
 *  takes a value or changes what git runs. */
const SAFE_GIT_GLOBALS: ReadonlySet<string> = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs"]);

/**
 * Reject known program-launching Git forms before the shared read-only policy
 * checks the subcommand and its options. The subcommand is the first word after
 * safe globals; any other leading option is refused by name.
 */
function gitEscape(argv: readonly string[]): string | undefined {
  const args = argv.slice(1);
  let sub: string | undefined;
  for (const arg of args) {
    if (!arg.startsWith("-")) {
      sub = arg;
      break;
    }
    if (!SAFE_GIT_GLOBALS.has(arg)) {
      return `git '${arg}' before the subcommand is a global option this host does not pass (only ${[...SAFE_GIT_GLOBALS].join(", ")})`;
    }
  }
  for (const arg of args) {
    if (arg === "-c" || arg.startsWith("--config-env")) {
      return `git '${arg}' sets configuration for one call, which can alias a command to a shell`;
    }
    if (arg.startsWith("--exec-path")) return "git '--exec-path' chooses which programs git runs";
    if (arg.startsWith("!")) return "a '!' alias body is a shell command";
  }
  if (sub !== undefined && GIT_RUNS_PROGRAMS.has(sub)) return `git ${sub} runs another program`;
  if (sub === "bisect" && args.includes("run")) return "git bisect run runs a command per step";
  if (sub === "rebase" && args.some((a) => a === "-x" || a === "--exec" || a.startsWith("--exec="))) {
    return "git rebase --exec runs a command per commit";
  }
  if (sub === "submodule" && args.includes("foreach")) return "git submodule foreach runs a command";
  if (sub === "config" && !args.some((a) => GIT_CONFIG_READS.has(a))) {
    return "git config may only read here (--get, --list): a written core.hooksPath or alias is a shell";
  }
  return undefined;
}

/**
 * Decide one Bash command for a role. `ctx.cwd` is the project root, which
 * `rm <path>` needs: it is judged by the same decide() a pi `remove` is, and
 * Claude Code names files by absolute path.
 */
export function decideBash(role: Role, command: string, ctx: Ctx): BashDecision {
  const shown = summarize(command);
  const words = shellWords(command);
  if (!words.ok) {
    return block(
      `path-gate: ${role} may not run '${shown}': ${words.reason} — Bash here carries only ${carriers(role)}, one plain command at a time`,
    );
  }
  const argv = words.argv;
  const head = argv[0];
  if (head === undefined) {
    return block(`path-gate: ${role} may not run an empty command — Bash here carries only ${carriers(role)}`);
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
    return block(
      `path-gate: ${role} may not run '${shown}': an env assignment prefix — Bash here carries only ${carriers(role)}`,
    );
  }

  const tools = ROLE_TOOLS[role];
  switch (head) {
    case "bounded": {
      if (argv[1] === "gates") return decideGate(role, argv.slice(1));
      const sub = argv[1] === undefined ? "'bounded' with no subcommand" : `'bounded ${argv[1]}'`;
      return block(
        `path-gate: ${role} may not run ${sub}: in this pipeline Bash carries only ${carriers(role)}`,
      );
    }
    case "git":
      if (!tools.includes("git")) {
        return block(`path-gate: ${role} may not run 'git': ${forbiddenWhy(role, "git")}`);
      }
      return decideGit(role, argv, shown);
    case "sleep":
      if (!tools.includes("sleep")) {
        return block(`path-gate: ${role} may not run 'sleep': ${forbiddenWhy(role, "sleep")}`);
      }
      return decideSleep(role, argv, shown);
    // No ROLE_TOOLS check here: a role without `remove` (the reviewer) has no
    // write zone, and decide() already says so in the reviewer's own words.
    case "rm":
      return decideRm(role, argv, shown, ctx);
    case "ls":
    case "find":
      return decideListing(role, argv, shown, ctx);
    default:
      return block(
        `path-gate: ${role} may not run '${head}': ${forbiddenWhy(role, "bash")} — in Claude Code, Bash carries only ${carriers(role)}`,
      );
  }
}

/** Flags the HOST supplies, never the model. The role reaches the CLI as
 *  `BOUNDED_DEV_STAGE_ROLE` in the env prefix the hook adds (path-gate-hook.ts),
 *  so a `--role` in the argv is a role claim — and a claim is refused, not
 *  compared. A findings file would be a way to hand a gate bytes the hook
 *  never judged; findings are passed inline. */
const HOST_ONLY_FLAGS = ["--role", "--findings-file"] as const;

function decideGate(role: Role, argv: readonly string[]): BashDecision {
  const claimed = argv.find((a) => HOST_ONLY_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)));
  if (claimed !== undefined) {
    return block(
      `path-gate: ${role} may not pass '${claimed}' to bounded gates: the host supplies the role and findings are passed inline`,
    );
  }
  const arg = argv[1];
  if (arg === undefined) {
    return block(`path-gate: ${role} may not run 'bounded gates' with no gate — 'bounded gates --list' shows them`);
  }
  if (arg === "--list" || arg === "--help" || arg === "-h") return allow("bounded gates");
  const tool = gateTool(arg);
  const mine = cliGates(role);
  if (mine.includes(tool)) return allow("bounded gates");
  // A gate some other role holds: pi's own sentence for it. The GATE_TOOLS are
  // not in FORBIDDEN_TOOLS (pi's frontmatter strip keeps them from the
  // workers), but forbiddenWhy still names their owner correctly.
  if (ALL_GATES.has(tool)) {
    return block(`path-gate: ${role} may not run 'bounded gates ${arg}': ${forbiddenWhy(role, tool)}`);
  }
  return block(
    `path-gate: ${role} may not run 'bounded gates ${arg}': no such gate for this role — ${role}'s gates are ${mine.map(gateCommand).join(", ")}`,
  );
}

function decideGit(role: Role, argv: readonly string[], shown: string): BashDecision {
  const why = gitEscape(argv);
  if (why !== undefined) return block(`path-gate: ${role} may not run '${shown}': ${why}`);
  const policy = gitPolicy(argv.slice(1));
  if (policy !== undefined) return block(`path-gate: ${role} may not run '${shown}': ${policy}`);
  return allow("git");
}

function decideSleep(role: Role, argv: readonly string[], shown: string): BashDecision {
  const arg = argv[1];
  if (argv.length !== 2 || arg === undefined || !/^\d+$/.test(arg)) {
    return block(`path-gate: ${role} may not run '${shown}': sleep takes one whole number of seconds`);
  }
  if (!isSleepSeconds(Number(arg))) {
    return block(
      `path-gate: ${role} may not run '${shown}': sleep is bounded to ${SLEEP_MIN_SECONDS}-${SLEEP_MAX_SECONDS} seconds`,
    );
  }
  return allow("sleep");
}

/** `rm <one path>` — no flags, no globs even quoted, one file — judged as a
 *  pi `remove` so the write zones apply. Directories, `-r`, `-f` and lists
 *  are refused: the pi tool removes one file, and so does this. The layout in
 *  `ctx` (source roots, test suffixes, generated globs) is what places the
 *  file; a ctx without it refuses every blind role's rm (fail closed). The
 *  hook builds it with `pathGateCtx` (src/path-gate.ts). */
function decideRm(role: Role, argv: readonly string[], shown: string, ctx: Ctx): BashDecision {
  const path = argv[1];
  if (argv.length !== 2 || path === undefined || path.startsWith("-")) {
    return block(`path-gate: ${role} may not run '${shown}': rm takes exactly one path and no flags`);
  }
  if (/[*?[\]]|^~/.test(path)) {
    return block(`path-gate: ${role} may not run '${shown}': rm takes one literal path, not a pattern`);
  }
  const zone: Decision = decide(role, "remove", { path }, ctx);
  return zone.allow ? allow("rm") : zone;
}

/** `ls` / `find` — names only (listing.ts), judged as pi's own `ls` / `find`
 *  calls by the same decide(), so a blind role may list the other side's
 *  names and never its contents (ADR 2026-057). */
function decideListing(role: Role, argv: readonly string[], shown: string, ctx: Ctx): BashDecision {
  const listing = listingCall(argv);
  if (!listing.ok) return block(`path-gate: ${role} may not run '${shown}': ${listing.reason}`);
  const { tool } = listing.call;
  // A pattern that reaches outside the searched directory or names .git is
  // refused for every role, not only the blind ones, as it is for the lead.
  if (!listing.call.patterns.every(searchPatternContained)) {
    return block(`path-gate: ${role} may not run '${shown}': a find pattern must be relative, stay inside the searched directory and away from .git`);
  }
  if (!ROLE_TOOLS[role].includes(tool)) {
    return block(`path-gate: ${role} may not run '${tool}': ${forbiddenWhy(role, tool)}`);
  }
  for (const input of gateInputs(listing.call)) {
    const zone: Decision = decide(role, tool, input, ctx);
    if (!zone.allow) return zone;
  }
  const linked = linkedPath(role, shown, listing.call.path, ctx);
  if (linked !== undefined) return linked;
  return allow(tool);
}

/**
 * The shell follows links; the gate judged the path as written. So a shell
 * listing or search runs only on a path whose real location IS the path as
 * written — no link on the way, no case folding — or a link could carry it
 * into `.git` or out of the project. Without the host's path facts nothing
 * can be shown, so the command is refused (fail closed).
 */
function linkedPath(role: Role, shown: string, path: string, ctx: Ctx): BashDecision | undefined {
  const asWritten = ctx.pathFacts?.asWritten;
  if (asWritten === undefined) {
    return block(`path-gate: ${role} may not run '${shown}': the gate cannot see where '${path}' really leads`);
  }
  if (!asWritten.call(ctx.pathFacts, path)) {
    return block(`path-gate: ${role} may not run '${shown}': '${path}' is a link, or reached through one, or spelled differently from its real name — use the real path`);
  }
  return undefined;
}

/** The command as a refusal quotes it: one line, bounded. */
function summarize(command: string): string {
  const oneLine = command.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
}
