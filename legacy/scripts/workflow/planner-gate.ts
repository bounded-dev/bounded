// planner-gate — the harness-planner development agent's PreToolUse hook.
//
//   (Claude Code runs it from .claude/agents/harness-planner.md's frontmatter
//   with the tool call's JSON on stdin.)
//
// The planner (docs/harness-workflow.md, ADR 2026-068) writes one file, its
// plan under .agent-state/, and reads everything else. Its prompt says so;
// this gate enforces it:
//
//   · Write, Edit, MultiEdit and NotebookEdit only to a path inside the
//     project's .agent-state/ directory, judged after resolving `..` and any
//     symbolic link on the way;
//   · Bash only as one plain command (no separators, pipes, redirects,
//     substitutions or globs: the Claude Code host's own shellWords reader)
//     from a read-only allowlist: git under the harness's read-only Git
//     policy, gh issue/pr view and list (and pr diff) without --web, ls, pwd.
//
// Any other tool passes through to the agent's own `tools:` allowlist. A
// refusal is a PreToolUse deny with the reason; an allowed call prints
// nothing. A payload it cannot read is refused, and the frontmatter command
// ends in `|| exit 2` so that a gate which cannot even start blocks the call
// instead of letting it through.
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { shellWords } from "../../agent/hosts/claude-code/bash-policy.ts";
import { deny } from "../../agent/hosts/claude-code/hook-output.ts";
import { gitPolicy } from "../../agent/src/git-policy.ts";

export type PlannerDecision = { readonly allow: true } | { readonly allow: false; readonly reason: string };

const WRITING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const STATE_DIR = ".agent-state";
const ALLOWED_COMMANDS = "gh issue view|list, gh pr view|list|diff, read-only git (log, show, diff, status, grep, ls-files, blame …), ls, pwd";
const GH_READS: Readonly<Record<string, ReadonlySet<string>>> = {
  issue: new Set(["view", "list"]),
  pr: new Set(["view", "list", "diff"]),
};

const ok: PlannerDecision = { allow: true };
const no = (reason: string): PlannerDecision => ({ allow: false, reason: `planner-gate: ${reason}` });

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
    return no(`the planner writes only its plan under ${STATE_DIR}/<issue>/, not ${path}`);
  }
  return ok;
}

function decideCommand(command: unknown): PlannerDecision {
  const refuse = (why: string) => no(`the planner may not run '${String(command).slice(0, 80)}': ${why}. It may run ${ALLOWED_COMMANDS}`);
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
      if (!GH_READS[noun]?.has(verb)) return refuse(`gh ${noun} ${verb} is not a read`);
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
  if (WRITING_TOOLS.has(tool)) return decideWrite(input["file_path"] ?? input["notebook_path"], root);
  if (tool === "Bash") return decideCommand(input["command"]);
  return ok;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  let out: string;
  try {
    const payload = JSON.parse(readFileSync(0, "utf8")) as { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
    const root = process.env["CLAUDE_PROJECT_DIR"] ?? (typeof payload.cwd === "string" ? payload.cwd : process.cwd());
    const decision = decidePlanner(payload, root);
    out = decision.allow ? "" : deny(decision.reason);
  } catch (error) {
    out = deny(`planner-gate: could not read the tool call (${error instanceof Error ? error.message : String(error)}); refused`);
  }
  process.stdout.write(out);
}
