// The composition root: the only place that chooses the adapters and reads
// the environment. It returns the hook, ready to host; main.ts hosts it.
//
// THE SEAM: `decide`. Today it is injected (tests, test/fixtures). Once the
// core integration lands, `decideFromConfig` loads the project's
// bounded.config.ts, composes its packs and dispatches over the composed
// guards; nothing else here changes.
import { Verdict } from "bounded/domain";
import { type Decide, respond, runHook } from "./hook.ts";
import { projectPaths } from "./paths.ts";

export interface Wiring {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The hook command's own arguments, after the script. */
  readonly argv: readonly string[];
  readonly decide: Decide;
}

/** Until bounded.config.ts is wired in, an installed hook refuses: installed means enforced, never silently open. */
export const decideFromConfig: Decide = () =>
  Verdict.refuse(
    "bounded's Claude Code hook is installed, but this version cannot load bounded.config.ts yet",
    "Remove bounded's PreToolUse hook from .claude/settings.json until a version that loads bounded.config.ts is installed",
  );

/** The hook for one process: stdin text in, stdout text out. */
export function composeHook({ env, argv, decide }: Wiring): (stdin: string) => string {
  const projectDir = env.CLAUDE_PROJECT_DIR;
  if (projectDir === undefined || !projectDir.startsWith("/")) {
    return refuseAll(
      "CLAUDE_PROJECT_DIR is not set to an absolute directory, so no path can be checked",
      "Run the hook from Claude Code, which sets CLAUDE_PROJECT_DIR to the project's root",
    );
  }
  const role = roleFrom(argv);
  if (role === undefined) return refuseAll("--role is given without a role label", "Give the role after it, as in --role builder");
  return (stdin) => runHook(stdin, { projectDir, role, decide, paths: projectPaths(projectDir) });
}

/** `--role <label>` or `--role=<label>`; null when absent, undefined when given without a label. */
function roleFrom(argv: readonly string[]): string | null | undefined {
  const at = argv.findIndex((arg) => arg === "--role" || arg.startsWith("--role="));
  if (at === -1) return null;
  const label = argv[at]?.startsWith("--role=") ? argv[at]?.slice("--role=".length) : argv[at + 1];
  return label === undefined || label === "" || label.startsWith("--") ? undefined : label;
}

function refuseAll(reason: string, redirect: string): (stdin: string) => string {
  const answer = respond(Verdict.refuse(reason, redirect));
  return () => answer;
}
