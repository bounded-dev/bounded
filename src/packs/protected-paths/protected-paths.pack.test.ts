import { describe, expect, test } from "bun:test";
import { corePack } from "bounded/domain";
import { shellSnapshotsPort, watchedFilesPort } from "./application/watch-shell/watch-shell.contract.ts";
import { protectedPathsPack } from "./protected-paths.pack.ts";

describe("protectedPathsPack — the protected-paths pack's overview", () => {
  test("is bounded/protected-paths, depending on the core, declaring protectedPaths with no rules of its own", () => {
    expect(protectedPathsPack.id.value).toBe("bounded/protected-paths");
    expect(protectedPathsPack.dependsOn).toEqual([corePack]);
    expect(Object.keys(protectedPathsPack.points)).toEqual(["protectedPaths"]);
    expect(protectedPathsPack.points.protectedPaths.ownValues).toEqual([]);
  });

  test("contributes its guards, and its checks around tool calls", () => {
    expect(protectedPathsPack.contributes.map((given) => given.point.id)).toEqual([
      "bounded/core.effectGuards.read",
      "bounded/core.effectGuards.list",
      "bounded/core.effectGuards.write",
      "bounded/core.effectGuards.execute",
      "bounded/core.beforeTool",
      "bounded/core.afterTool",
    ]);
  });

  test("declares the ports a host provides: watched files and shell snapshots", () => {
    expect(protectedPathsPack.ports).toEqual({ watchedFiles: watchedFilesPort, shellSnapshots: shellSnapshotsPort });
    expect(protectedPathsPack.problem).toBeUndefined();
  });
});
