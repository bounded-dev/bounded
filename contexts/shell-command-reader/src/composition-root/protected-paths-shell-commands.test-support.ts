import { type Clock, type GuardLog, JudgeEventHandler } from "bounded/application";
import { type BasePack, Composition, corePack, DecisionTime, type ProjectPath, type Verdict } from "bounded/domain";
import { protectedPathsPack } from "bounded/protected-paths";
import { type PathKind, TreeSitterShellCommandReader } from "bounded-shell-command-reader/adapters";

/** The project root the shell tests judge their commands in. */
export const ROOT = "/work/project";

/** What a test says is at a path: a kind, or "unknown" when it cannot be told. */
export type PathsForTest = Readonly<Record<string, PathKind | "unknown">>;

const time = DecisionTime.parse("2026-10-07T12:00:00.000Z");
if (!time.ok) throw new Error(time.error);
const clock: Clock = { now: () => time.value };
const log: GuardLog = { record: async () => {} };

/**
 * The core, the protected-paths pack and `packs`, judged as openProject's judge judges:
 * each shell command read by bounded's shell command reader, with `paths`
 * saying what is at a path (the root a directory, anything not given
 * absent), then the guards. Gives a way to judge a call.
 */
export async function opened(packs: readonly BasePack[], paths: PathsForTest = {}): Promise<(effects: readonly object[], tool?: string) => Promise<Verdict>> {
  const all = [corePack, protectedPathsPack, ...packs];
  const composed = Composition.compose(all, all);
  if (!composed.ok) throw new Error(composed.error);
  const pathKindOf = (_projectRoot: string, { value: path }: ProjectPath): PathKind | undefined => {
    const given = Object.hasOwn(paths, path) ? paths[path] : undefined;
    if (given === "unknown") return undefined;
    return given ?? (path === "." ? "directory" : "absent");
  };
  const handler = new JudgeEventHandler(composed.value, log, clock, { shellCommandReader: new TreeSitterShellCommandReader({ pathKindOf }), projectRoot: ROOT });
  let calls = 0;
  return async (effects, tool = "shell") => handler.judge({ kind: "tool-use", role: null, tool, effects, callId: `c-${++calls}` });
}
