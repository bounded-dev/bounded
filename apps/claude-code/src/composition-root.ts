// The composition root: the only place that chooses the adapters and reads
// the environment. It returns the hook, ready to host; run.ts hosts it.
//
// THE SEAM: `decide`. Today it is injected (tests, test/fixtures). Once the
// core integration lands, `decideFromConfig` loads the project's
// bounded.config.ts, composes its packs and dispatches over the composed
// guards; nothing else here changes.
import { Verdict } from "bounded/domain";
import { type Decide, respond, runHook } from "./hook.ts";
import { projectPaths } from "./paths.ts";

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
  /** Defaults to DEADLINE_MS; tests inject a short one. */
  readonly deadlineMs?: number;
}

/** Until bounded.config.ts is wired in, an installed hook refuses: installed means enforced, never silently open. */
export const decideFromConfig: Decide = () =>
  Verdict.refuse(
    "bounded's Claude Code hook is installed, but this version cannot load bounded.config.ts yet",
    "Remove bounded's PreToolUse hook from .claude/settings.json until a version that loads bounded.config.ts is installed",
  );

/** The hook for one process: stdin text in, stdout text out. */
export function composeHook({ env, argv, decide, deadlineMs = DEADLINE_MS }: Wiring): (stdin: string) => Promise<string> {
  const projectDir = env.CLAUDE_PROJECT_DIR;
  if (projectDir === undefined || !projectDir.startsWith("/")) {
    return refuseAll(
      "CLAUDE_PROJECT_DIR is not set to an absolute directory, so no path can be checked",
      "Run the hook from Claude Code, which sets CLAUDE_PROJECT_DIR to the project's root",
    );
  }
  const role = roleFrom(argv);
  if (role === undefined) return refuseAll("--role is given without a role label", "Give the role after it, as in --role builder");
  return (stdin) => runHook(stdin, { projectDir, role, decide, paths: projectPaths(projectDir), deadlineMs });
}

/** `--role <label>` or `--role=<label>`; null when absent, undefined when given without a label. */
function roleFrom(argv: readonly string[]): string | null | undefined {
  const at = argv.findIndex((arg) => arg === "--role" || arg.startsWith("--role="));
  if (at === -1) return null;
  const label = argv[at]?.startsWith("--role=") ? argv[at]?.slice("--role=".length) : argv[at + 1];
  return label === undefined || label === "" || label.startsWith("--") ? undefined : label;
}

function refuseAll(reason: string, redirect: string): (stdin: string) => Promise<string> {
  const answer = respond(Verdict.refuse(reason, redirect));
  return async () => answer;
}
