import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ports } from "bounded/domain";
import { shellSnapshotsPort, watchedFilesPort } from "../../application/watch-shell/watch-shell.contract.ts";
import { protectedPathsPack } from "../../protected-paths.pack.ts";
import { protectedPathsPortProvisions } from "./port-provisions.ts";
import { FileSystemShellSnapshots } from "./shell-snapshots/shell-snapshots.ts";
import { FileSystemWatchedFiles } from "./watched-files/watched-files.ts";

describe("protectedPathsPortProvisions", () => {
  test("provides every port the protected-paths pack uses for a project, and only those: watched files and shell snapshots", () => {
    const root = mkdtempSync(join(tmpdir(), "port-provisions-"));
    const state = mkdtempSync(join(tmpdir(), "port-provisions-state-"));
    const provisions = protectedPathsPortProvisions(state);
    const ports = Ports.forProject(root, provisions);
    expect(ports.ok).toBe(true);
    if (!ports.ok) return;
    expect(ports.value.provides(watchedFilesPort)).toBe(true);
    const watched = ports.value.get(watchedFilesPort);
    expect(watched.ok).toBe(true);
    expect(watched.ok && watched.value).toBeInstanceOf(FileSystemWatchedFiles);
    expect(ports.value.provides(shellSnapshotsPort)).toBe(true);
    const snapshots = ports.value.get(shellSnapshotsPort);
    expect(snapshots.ok).toBe(true);
    expect(snapshots.ok && snapshots.value).toBeInstanceOf(FileSystemShellSnapshots);
    expect(Object.values(protectedPathsPack.ports).every((key) => ports.value.provides(key))).toBe(true);
    expect(provisions.length).toBe(Object.keys(protectedPathsPack.ports).length);
  });

  test("the provisions are frozen", () => {
    const provisions = protectedPathsPortProvisions(mkdtempSync(join(tmpdir(), "port-provisions-state-")));
    expect(provisions.length).toBe(2);
    expect(Object.isFrozen(provisions)).toBe(true);
  });
});
