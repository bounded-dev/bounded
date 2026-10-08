import { type BasePack, Composition, corePack, dispatchEvent, Ports, ToolUse, type Verdict } from "bounded/domain";
import { pathGate } from "bounded/path-gate";
import { InMemoryPathKinds } from "../../adapters/out/in-memory/path-kinds.ts";
import { TreeSitterShellParser } from "../../adapters/out/tree-sitter/shell-parser.ts";
import { type PathKind, type PathKinds, pathKindsPort, shellParserPort } from "./judge-calls.contract.ts";

/** The project root the shell tests open their compositions at. */
export const ROOT = "/work/project";

/** What a test says is at a path: a kind, or "unknown" when it cannot be told. */
export type PathsForTest = Readonly<Record<string, PathKind | "unknown">>;

/** Runs what packs do when a project at `root` opens, as openProject does, with the path gate's ports: `paths` (or a PathKinds) for what is at a path, and tree-sitter. */
export async function openComposition(composition: Composition, root: string, paths: PathsForTest | PathKinds = {}): Promise<void> {
  const kinds: PathKinds = "kindOf" in paths && typeof paths.kindOf === "function" ? (paths as PathKinds) : new InMemoryPathKinds(paths as PathsForTest);
  const ports = Ports.forProject(root, [Ports.provide(pathKindsPort, () => kinds), Ports.provide(shellParserPort, () => new TreeSitterShellParser())]);
  if (!ports.ok) throw new Error(ports.error);
  const openings = composition.read(corePack.points.onProjectOpen);
  if (!openings.ok) throw new Error(openings.error);
  for (const open of openings.value) await open({ root }, { composition, ports: ports.value });
}

/** The core, the path gate and `packs`, composed and opened as openProject opens a project; then a way to decide a call. */
export async function opened(packs: readonly BasePack[], paths: PathsForTest = {}): Promise<(effects: readonly object[], tool?: string) => Verdict> {
  const all = [corePack, pathGate, ...packs];
  const composed = Composition.compose(all, all);
  if (!composed.ok) throw new Error(composed.error);
  await openComposition(composed.value, ROOT, paths);
  return (effects, tool = "shell") => {
    const call = ToolUse.parse({ role: null, tool, effects });
    if (!call.ok) throw new Error(call.error);
    return dispatchEvent(composed.value, call.value);
  };
}
