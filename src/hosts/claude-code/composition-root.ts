// The composition root: the only place that chooses the adapters and reads
// the environment. It returns the hook, ready to host; run.ts hosts it.
//
// THE SEAM: `decide`, with the optional `afterTool`, `record` and `recordAgentRunFinish`. main.ts
// passes the `...FromConfig` ones, which open the project with its
// bounded.config.ts and ask the core's judge; tests inject their own.
import { Verdict } from "bounded/domain";
import { openProject } from "bounded/open-project";
import { protectedPathsPortProvisions } from "bounded/protected-paths/adapters";
import { prereqsPortProvisions } from "bounded/prereqs/adapters";
import { openShellCommandReading, type ReadShellCommand } from "bounded-shell-command-reader/shell-command-reading";
import { type AfterTool, type Decide, hookEventOf, type RecordAgentRunFinish, type RecordRefusal, respond, runHook } from "./hook.ts";
import { projectPaths } from "./paths.ts";

/**
 * How this process reads shell commands (ADR 2026-020): bounded's reader,
 * its grammar loading once. The hook reads each execute effect's command
 * with it when it builds the core's event.
 */
const shellCommandReading = openShellCommandReading();

/** Opens a project with the adapters this host provides: the protected-paths pack's and the prerequisites pack's, on disk. */
const open = (projectRoot: string) => openProject(projectRoot, { ports: [...protectedPathsPortProvisions(), ...prereqsPortProvisions()] });

/**
 * How long bounded may take to decide, then how long work still pending after
 * the answer may run before the process exits. Together they end well before
 * the installed hook's timeout (install.ts): a hook Claude Code aborts is not
 * blocking, so the deny must be out and the process gone first. The deadline
 * bounds asynchronous work only: a decide busy synchronously can still overrun.
 */
export const DEADLINE_MS = 20_000;
export const DRAIN_MS = 5_000;

export interface Wiring {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The hook command's own arguments, after the script. */
  readonly argv: readonly string[];
  readonly decide: Decide;
  readonly afterTool?: AfterTool;
  readonly record?: RecordRefusal;
  readonly recordAgentRunFinish?: RecordAgentRunFinish;
  /** How shell commands are read; bounded's reader by default, tests inject their own. */
  readonly readShellCommand?: ReadShellCommand;
  /** Defaults to DEADLINE_MS; tests inject a short one. */
  readonly deadlineMs?: number;
}

/**
 * Judges with the project's bounded.config.ts: the core composes its packs,
 * decides and records the decision in .bounded/log.jsonl. Its refusal
 * names the refusing pack and effect. Anything openProject or the judge
 * throws or rejects with reaches the hook, which denies.
 */
export const decideFromConfig: Decide = async (event, { projectRoot }) => {
  const project = await open(projectRoot);
  return project.judge(event);
};

/** After a call ran: the project's judge undoes what a shell command changed in watched files, and says so. */
export const afterToolFromConfig: AfterTool = async (result, { projectRoot }) => {
  const { message } = await (await open(projectRoot)).afterTool(result);
  return { message };
};

/** Records a refusal the hook made itself in the project's Bounded log. */
export const recordFromConfig: RecordRefusal = async (refusal, { projectRoot }) => (await open(projectRoot)).refuse(refusal);

/** When a subagent stops: the project's judge hands its run's finish to the packs, which record what they find (ADR 2026-025). */
export const recordAgentRunFinishFromConfig: RecordAgentRunFinish = async (finish, { projectRoot }) => (await open(projectRoot)).recordAgentRunFinish(finish);

/**
 * The hook for one process: stdin text in, stdout text out. The shell
 * command reader starts preparing here, once, without the hook waiting for
 * it: a first read waits for it, within the reader's own bounds and the
 * hook's deadline.
 */
export function composeHook({ env, argv, decide, afterTool, record, recordAgentRunFinish, readShellCommand = shellCommandReading, deadlineMs = DEADLINE_MS }: Wiring): (stdin: string) => Promise<string> {
  const projectRoot = env.CLAUDE_PROJECT_DIR;
  if (projectRoot === undefined || !projectRoot.startsWith("/")) {
    return refuseAll(
      "CLAUDE_PROJECT_DIR is not set to an absolute directory, so no path can be checked",
      "Run the hook from Claude Code, which sets CLAUDE_PROJECT_DIR to the project's root",
    );
  }
  const role = roleFrom(argv);
  if (role === undefined) return refuseAll("--role is given without a role label", "Give the role after it, as in --role builder");
  // Started, never awaited: it never rejects, and the hook answers whether or not it has finished.
  void readShellCommand.prepare();
  const extras = {
    ...(afterTool === undefined ? {} : { afterTool }),
    ...(record === undefined ? {} : { record }),
    ...(recordAgentRunFinish === undefined ? {} : { recordAgentRunFinish }),
  };
  return (stdin) => runHook(stdin, { projectRoot, role, decide, paths: projectPaths(projectRoot), readShellCommand, deadlineMs, ...extras });
}

/** `--role <label>` or `--role=<label>`; null when absent, undefined when given without a label. */
function roleFrom(argv: readonly string[]): string | null | undefined {
  const at = argv.findIndex((arg) => arg === "--role" || arg.startsWith("--role="));
  if (at === -1) return null;
  const label = argv[at]?.startsWith("--role=") ? argv[at]?.slice("--role=".length) : argv[at + 1];
  return label === undefined || label === "" || label.startsWith("--") ? undefined : label;
}

/** Denies every call with `reason`; a SubagentStop is answered with nothing, since a deny means nothing there and a block would keep the subagent running. */
function refuseAll(reason: string, redirect: string): (stdin: string) => Promise<string> {
  const answer = respond(Verdict.refuse(reason, redirect));
  return async (stdin) => (hookEventOf(stdin) === "SubagentStop" ? "" : answer);
}
