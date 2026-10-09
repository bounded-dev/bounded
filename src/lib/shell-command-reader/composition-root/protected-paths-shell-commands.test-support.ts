import { type BoundedLog, type Clock, JudgeEventHandler } from "bounded/application";
import { type BasePack, Composition, corePack, DecisionTime, type ProjectPath, type Verdict } from "bounded/domain";
import { protectedPathsPack } from "bounded/protected-paths";
import { type PathKind, TreeSitterShellCommandReader } from "bounded-shell-command-reader/adapters";
import { ReadShellCommandHandler } from "bounded-shell-command-reader/application";

/** The project root the shell tests judge their commands in. */
export const ROOT = "/work/project";

/** What a test says is at a path: a kind, or "unknown" when it cannot be told. */
export type PathsForTest = Readonly<Record<string, PathKind | "unknown">>;

const time = DecisionTime.parse("2026-10-07T12:00:00.000Z");
if (!time.ok) throw new Error(time.error);
const clock: Clock = { now: () => time.value };
const log: BoundedLog = { record: async () => {} };

/** One field of a test's effect, own fields only. */
const fieldOf = (effect: object, name: string): unknown => (Object.hasOwn(effect, name) ? (effect as Record<string, unknown>)[name] : undefined);

/**
 * The core, the protected-paths pack and `packs`, judged as a host adapter
 * and openProject's judge judge them: each execute effect's command read by
 * bounded's shell command reader (ReadShellCommand over the tree-sitter
 * reader), with `paths` saying what is at a path (the root a directory,
 * anything not given absent), its reading put on the effect, then the
 * guards. Gives a way to judge a call.
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
  const reading = new ReadShellCommandHandler(new TreeSitterShellCommandReader({ pathKindOf }));
  const handler = new JudgeEventHandler(composed.value, log, clock);
  const withReading = async (effect: object): Promise<object> =>
    fieldOf(effect, "kind") === "execute" ? { ...effect, reading: await reading.read({ projectRoot: ROOT, command: fieldOf(effect, "command"), cwd: fieldOf(effect, "cwd") ?? null }) } : effect;
  let calls = 0;
  return async (effects, tool = "shell") => handler.judge({ kind: "tool-use", role: null, tool, effects: await Promise.all(effects.map(withReading)), callId: `c-${++calls}` });
}
