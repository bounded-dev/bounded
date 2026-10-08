// planner-gate — the planner development agent's PreToolUse hook.
//
//   (Claude Code runs it from .claude/agents/planner.md's frontmatter with the
//   tool call's JSON on stdin.)
//
// The planner (docs/development-workflow.md, ADR 2026-001) writes one file,
// its plan under .agent-state/, and reads everything else. Its brief says so;
// this gate enforces it:
//
//   · Write, Edit, MultiEdit and NotebookEdit only to a path inside the
//     project's .agent-state/ directory, judged after resolving `..` and any
//     symbolic link on the way;
//   · Bash only as one plain command (no separators, pipes, redirects,
//     substitutions, globs or escapes) from a read-only allowlist: git under
//     the read-only policy below, gh issue/pr view and list (and pr diff)
//     without --web, ls, pwd.
//
// Any other tool passes through to the agent's own `tools:` allowlist. A
// refusal is a PreToolUse deny with the reason; an allowed call prints
// nothing. A payload it cannot read is refused, and the frontmatter command
// ends in `|| exit 2` so that a gate which cannot even start blocks the call
// instead of letting it through.
//
// The file is self-contained on purpose: it imports nothing from the project,
// so a broken build cannot open the gate.
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export type PlannerDecision = { readonly allow: true } | { readonly allow: false; readonly reason: string };

const WRITING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const STATE_DIR = ".agent-state";
const ALLOWED_COMMANDS =
  "gh issue view|list, gh pr view|list|diff, read-only git (log, show, diff, status, grep, ls-files, ls-tree, blame, rev-parse), ls, pwd";
const GH_READS: Readonly<Record<string, ReadonlySet<string>>> = {
  issue: new Set(["view", "list"]),
  pr: new Set(["view", "list", "diff"]),
};

const ok: PlannerDecision = { allow: true };
const no = (reason: string): PlannerDecision => ({ allow: false, reason: `planner-gate: ${reason}` });

// --- Reading a command the way the shell will --------------------------------

export type Words = { readonly ok: true; readonly argv: readonly string[] } | { readonly ok: false; readonly reason: string };

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

/** Inside double quotes the shell still expands these. */
const DOUBLE_QUOTED_META: ReadonlyMap<string, string> = new Map([
  ["$", "a substitution ('$') inside double quotes"],
  ["`", "a substitution ('`') inside double quotes"],
  ["\\", "a backslash escape inside double quotes"],
]);

/**
 * Split a command into the argv a POSIX shell would pass, or say why it
 * cannot be read as one plain command. Single quotes are literal; double
 * quotes are literal except for the expansions above, which are refused
 * rather than modelled. A `#` or `~` opening a word is refused too.
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
    if (ch === "~" && !inWord) return { ok: false, reason: "a tilde expansion ('~')" };
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

// --- Read-only git -------------------------------------------------------------
//
// An allowlist that fails closed at every level: a global option, a
// subcommand, an option and a positional word are each accepted only when
// this table names them. Options that write files (`--output`), run programs
// (`--ext-diff`, `--textconv`, `-c`, `--exec-path`) or redirect git (`-C`,
// `--git-dir`) are simply absent. Every subcommand here takes revisions and
// paths as positionals and never writes, so positionals are free.

interface GitRule {
  /** Options that take no value. */
  readonly flags: ReadonlySet<string>;
  /** Options that take a value, as `--opt=v`, `--opt v`, `-ov` or `-o v`. */
  readonly valued: ReadonlySet<string>;
  /** Options whose value git reads only stuck on (`--opt=v`, `-ov`). */
  readonly stuck: ReadonlySet<string>;
  /** Accept `-<n>` as a count (log). */
  readonly count?: boolean;
}

const set = (...items: string[]): ReadonlySet<string> => new Set(items);
const DIFF_FLAGS = [
  "--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--check", "--summary",
  "-p", "--patch", "--no-patch", "-s", "-w", "--ignore-all-space", "--no-color",
  "--no-ext-diff", "--no-textconv", "--no-renames", "-M", "--find-renames", "--raw",
];
const LOG_FLAGS = [
  ...DIFF_FLAGS, "--oneline", "--all", "--decorate", "--no-decorate", "--graph", "--reverse",
  "--first-parent", "--no-merges", "--merges", "--follow", "--abbrev-commit",
];
const LOG_VALUED = ["--diff-filter", "-n", "--max-count", "--skip", "--since", "--until", "--author", "--grep", "-S", "-G", "--date"];
// `--format` and `--pretty` only stuck on: a separate next word would be read
// as git's own option (`--format --output=/x` writes /x).
const LOG_STUCK = ["--unified", "-U", "--format", "--pretty", "--word-diff", "--stat"];

const LOG: GitRule = { flags: set(...LOG_FLAGS), valued: set(...LOG_VALUED), stuck: set(...LOG_STUCK), count: true };
const GIT: ReadonlyMap<string, GitRule> = new Map<string, GitRule>([
  ["status", { flags: set("--short", "-s", "--branch", "-b", "--porcelain", "--long"), valued: set(), stuck: set("--porcelain", "--untracked-files", "-u") }],
  ["diff", { flags: set(...DIFF_FLAGS, "--cached", "--staged", "--merge-base"), valued: set("--diff-filter"), stuck: set("--unified", "-U", "--stat") }],
  ["log", LOG],
  ["show", { ...LOG, count: false }],
  ["grep", {
    flags: set("-n", "--line-number", "-i", "--ignore-case", "-F", "-E", "-w", "-l", "-c", "-v", "--cached", "-h", "-H"),
    valued: set("-e", "-A", "-B", "-C"),
    stuck: set(),
  }],
  ["ls-files", { flags: set("-s", "--stage", "--cached", "-c", "--others", "-o", "--exclude-standard", "--modified", "-m", "--deleted", "-d"), valued: set(), stuck: set() }],
  ["ls-tree", { flags: set("-r", "-t", "-d", "-l", "--long", "--name-only", "--full-tree"), valued: set(), stuck: set() }],
  ["blame", { flags: set("-w", "-s", "-e", "-l", "--porcelain"), valued: set("-L"), stuck: set() }],
  ["rev-parse", { flags: set("--show-toplevel", "--abbrev-ref", "--verify", "--quiet", "-q", "--short", "--is-inside-work-tree"), valued: set(), stuck: set() }],
]);
const GIT_GLOBALS = set("--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs");

/** Undefined accepts a read-only git invocation (the words after `git`); a sentence refuses it. */
export function gitPolicy(args: readonly string[]): string | undefined {
  const output = args.find((arg) => arg.startsWith("--output"));
  if (output !== undefined) return `git argument '${output}' writes a file`;
  let i = 0;
  while (i < args.length && GIT_GLOBALS.has(args[i] ?? "")) i++;
  const sub = args[i];
  const rule = sub === undefined ? undefined : GIT.get(sub);
  if (sub === undefined || rule === undefined) return `git '${sub ?? ""}' is not a read-only command here`;
  const rest = args.slice(i + 1);
  for (let k = 0; k < rest.length; k++) {
    const arg = rest[k] ?? "";
    if (arg === "--") break;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (rule.flags.has(arg) || (rule.count === true && /^-\d+$/.test(arg))) continue;
    if (rule.valued.has(arg)) {
      if (k + 1 >= rest.length) return `git ${sub} option '${arg}' needs a value`;
      k++;
      continue;
    }
    const takes = (name: string): boolean => rule.valued.has(name) || rule.stuck.has(name);
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0 && takes(arg.slice(0, eq))) continue;
    if (!arg.startsWith("--") && arg.length > 2 && takes(arg.slice(0, 2))) continue;
    return `git ${sub} option '${arg}' is not in its read-only allowlist`;
  }
  return undefined;
}

// --- The decision ----------------------------------------------------------------

/** Where an absolute `path` really points: every symbolic link on the way is followed, even one whose target does not exist yet. */
function realish(path: string, depth = 0): string {
  if (depth > 40) throw new Error(`too many symbolic links at ${path}`);
  const parent = dirname(path);
  const base = parent === path ? path : resolve(realish(parent, depth), basename(path));
  const stat = lstatSync(base, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink() === true) return realish(resolve(dirname(base), readlinkSync(base)), depth + 1);
  return base;
}

function decideWrite(path: unknown, root: string): PlannerDecision {
  if (typeof path !== "string" || path === "") return no("a write without a file path");
  const state = realish(resolve(root, STATE_DIR));
  const target = realish(resolve(root, path));
  const inside = relative(state, target);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    return no(`the planner writes only its plan under ${STATE_DIR}/<item>/, not ${path}`);
  }
  return ok;
}

function decideCommand(command: unknown): PlannerDecision {
  const refuse = (why: string): PlannerDecision =>
    no(`the planner may not run '${String(command).slice(0, 80)}': ${why}. It may run ${ALLOWED_COMMANDS}`);
  if (typeof command !== "string") return refuse("no command");
  const words = shellWords(command);
  if (!words.ok) return refuse(`${words.reason}; one plain command at a time`);
  const [head, ...args] = words.argv;
  switch (head) {
    case "git": {
      const why = gitPolicy(args);
      return why === undefined ? ok : refuse(why);
    }
    case "gh": {
      const [noun = "", verb = ""] = args;
      if (GH_READS[noun]?.has(verb) !== true) return refuse(`gh ${noun} ${verb} is not a read`);
      if (args.some((a) => a === "--web" || a === "-w" || a.startsWith("--web="))) return refuse("--web opens a browser");
      return ok;
    }
    case "ls":
    case "pwd":
      return ok;
    default:
      return refuse(head === undefined ? "an empty command" : `${head} is not on the planner's read-only list`);
  }
}

/** Decide one tool call by the planner, in the project rooted at `root`. */
export function decidePlanner(payload: { readonly tool_name?: unknown; readonly tool_input?: unknown }, root: string): PlannerDecision {
  const tool = payload.tool_name;
  const input = (typeof payload.tool_input === "object" && payload.tool_input !== null ? payload.tool_input : {}) as Record<string, unknown>;
  if (typeof tool !== "string") return no("a tool call without a tool name");
  if (WRITING_TOOLS.has(tool)) return decideWrite(input.file_path ?? input.notebook_path, root);
  if (tool === "Bash") return decideCommand(input.command);
  return ok;
}

/** The hook's stdout for a refusal: Claude Code's PreToolUse deny. */
export function deny(reason: string): string {
  return `${JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  })}\n`;
}

if (import.meta.main) {
  let out: string;
  try {
    const payload = JSON.parse(readFileSync(0, "utf8")) as { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
    const root = process.env.CLAUDE_PROJECT_DIR ?? (typeof payload.cwd === "string" ? payload.cwd : process.cwd());
    const decision = decidePlanner(payload, root);
    out = decision.allow ? "" : deny(decision.reason);
  } catch (error) {
    out = deny(`planner-gate: could not read the tool call (${error instanceof Error ? error.message : String(error)}); refused`);
  }
  process.stdout.write(out);
}
