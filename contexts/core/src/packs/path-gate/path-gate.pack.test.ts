import { describe, expect, test } from "bun:test";
import { corePack } from "bounded/domain";
import { pathKindsPort, shellParserPort } from "./application/judge-calls/judge-calls.contract.ts";
import { shellSnapshotsPort, watchedFilesPort } from "./application/watch-shell/watch-shell.contract.ts";
import { pathGate } from "./path-gate.pack.ts";

describe("pathGate — the path gate's overview", () => {
  test("is bounded/path-gate, depending on the core, declaring protectedPaths with its own rules first", () => {
    expect(pathGate.id.value).toBe("bounded/path-gate");
    expect(pathGate.dependsOn).toEqual([corePack]);
    expect(Object.keys(pathGate.points)).toEqual(["protectedPaths"]);
    expect(pathGate.points.protectedPaths.ownValues.length).toBe(2);
  });

  test("contributes its guards, its work on opening a project, and its checks around tool calls", () => {
    expect(pathGate.contributes.map((given) => given.point.id)).toEqual([
      "bounded/core.effectGuards.read",
      "bounded/core.effectGuards.list",
      "bounded/core.effectGuards.write",
      "bounded/core.effectGuards.execute",
      "bounded/core.onProjectOpen",
      "bounded/core.beforeTool",
      "bounded/core.afterTool",
    ]);
  });

  test("declares the ports a host provides: watched files, shell snapshots, path kinds and the shell parser", () => {
    expect(pathGate.ports).toEqual({ watchedFiles: watchedFilesPort, shellSnapshots: shellSnapshotsPort, pathKinds: pathKindsPort, shellParser: shellParserPort });
    expect(pathGate.problem).toBeUndefined();
  });
});
