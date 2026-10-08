import { type AnyPack, Composition, corePack, dispatchEvent, type PathKind, type ProjectPath, ToolUse, type Verdict } from "bounded/domain";
import { pathGate } from "bounded/path-gate";

/** The project root the shell tests open their compositions at. */
export const ROOT = "/work/project";

/** What a test says is at a path: a kind, or "unknown" when it cannot be told. */
export type PathsForTest = Readonly<Record<string, PathKind | "unknown">>;

/** What is at `path` for a test: as given, else a directory for the root, else nothing. */
export function kindOfPathFor(paths: PathsForTest): (path: ProjectPath) => PathKind | undefined {
  return ({ value: path }) => {
    const given = paths[path];
    if (given === "unknown") return undefined;
    return given ?? (path === "." ? "directory" : "absent");
  };
}

/** The core, the path gate and `packs`, composed and opened as openProject opens a project; then a way to decide a call. */
export async function opened(packs: readonly AnyPack[], paths: PathsForTest = {}): Promise<(effects: readonly object[], tool?: string) => Verdict> {
  const all = [corePack, pathGate, ...packs];
  const composed = Composition.compose(all, all);
  if (!composed.ok) throw new Error(composed.error);
  const openings = composed.value.read(corePack.points.onProjectOpen);
  if (!openings.ok) throw new Error(openings.error);
  for (const open of openings.value) await open({ root: ROOT, kindOfPath: kindOfPathFor(paths) }, composed.value);
  return (effects, tool = "shell") => {
    const call = ToolUse.parse({ role: null, tool, effects });
    if (!call.ok) throw new Error(call.error);
    return dispatchEvent(composed.value, call.value);
  };
}
