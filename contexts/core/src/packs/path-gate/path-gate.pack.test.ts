import { describe, expect, test } from "bun:test";
import { corePack } from "bounded/domain";
import { shellSnapshotsPort, watchedFilesPort } from "./application/watch-shell/watch-shell.contract.ts";
import { pathGate } from "./path-gate.pack.ts";

describe("pathGate — the path gate's overview", () => {
  test("is bounded/path-gate, depending on the core, declaring protectedPaths with no rules of its own", () => {
    expect(pathGate.id.value).toBe("bounded/path-gate");
    expect(pathGate.dependsOn).toEqual([corePack]);
    expect(Object.keys(pathGate.points)).toEqual(["protectedPaths"]);
    expect(pathGate.points.protectedPaths.ownValues).toEqual([]);
  });

  test("contributes its guards, and its checks around tool calls", () => {
    expect(pathGate.contributes.map((given) => given.point.id)).toEqual([
      "bounded/core.effectGuards.read",
      "bounded/core.effectGuards.list",
      "bounded/core.effectGuards.write",
      "bounded/core.effectGuards.execute",
      "bounded/core.beforeTool",
      "bounded/core.afterTool",
    ]);
  });

  test("declares the ports a host provides: watched files and shell snapshots", () => {
    expect(pathGate.ports).toEqual({ watchedFiles: watchedFilesPort, shellSnapshots: shellSnapshotsPort });
    expect(pathGate.problem).toBeUndefined();
  });
});
