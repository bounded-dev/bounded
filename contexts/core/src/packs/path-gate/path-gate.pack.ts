import { contribution, corePack, definePack } from "bounded/domain";
import { judgeExecute, judgeList, judgeRead, judgeWrite } from "./application/judge-calls/judge-calls.ts";
import { shellSnapshotsPort, watchedFilesPort } from "./application/watch-shell/watch-shell.contract.ts";
import { restoreWatched, snapshotBeforeShell } from "./application/watch-shell/watch-shell.lifecycle.ts";
import { pathGateId } from "./domain/path-gate-id.ts";
import { protectedPathsPoint } from "./domain/protected-path.ts";
import type { PathGate } from "./path-gate.contract.ts";

/**
 * The path gate, `bounded/path-gate`: an ordinary pack. Packs and projects
 * contribute deny-only rules to `protectedPaths`; its guards judge reads,
 * listings and writes against them. A shell command's paths cannot really
 * be read from its text: the path gate refuses, best effort, one whose
 * reading (the core's, ADR 2026-020) names a protected path, and watches
 * what it protects from writes around every shell command, undoing its
 * changes. Fetch, delegate and invoke are not judged by path. What a host
 * must provide is its ports section.
 */
export const pathGate: PathGate = definePack({
  id: pathGateId,
  dependsOn: [corePack],
  points: { protectedPaths: protectedPathsPoint },
  contributes: [
    contribution(corePack.points.effectGuards.read, [judgeRead]),
    contribution(corePack.points.effectGuards.list, [judgeList]),
    contribution(corePack.points.effectGuards.write, [judgeWrite]),
    contribution(corePack.points.effectGuards.execute, [judgeExecute]),
    contribution(corePack.points.beforeTool, [snapshotBeforeShell]),
    contribution(corePack.points.afterTool, [restoreWatched]),
  ],
  ports: { watchedFiles: watchedFilesPort, shellSnapshots: shellSnapshotsPort },
});
