import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ports } from "bounded/domain";
import { pathKindsPort, shellParserPort } from "../../application/judge-calls/judge-calls.contract.ts";
import { shellSnapshotsPort, watchedFilesPort } from "../../application/watch-shell/watch-shell.contract.ts";
import { pathGatePortProvisions } from "./port-provisions.ts";

describe("pathGatePortProvisions", () => {
  test("provides every port the path gate uses for a project: watched files, shell snapshots, path kinds and the shell parser", () => {
    const root = mkdtempSync(join(tmpdir(), "port-provisions-"));
    const state = mkdtempSync(join(tmpdir(), "port-provisions-state-"));
    const ports = Ports.forProject(root, pathGatePortProvisions(state));
    expect(ports.ok).toBe(true);
    if (!ports.ok) return;
    expect(ports.value.provides(watchedFilesPort)).toBe(true);
    expect(ports.value.get(watchedFilesPort).ok).toBe(true);
    expect(ports.value.provides(shellSnapshotsPort)).toBe(true);
    expect(ports.value.get(shellSnapshotsPort).ok).toBe(true);
    expect(ports.value.provides(pathKindsPort)).toBe(true);
    expect(ports.value.get(pathKindsPort).ok).toBe(true);
    expect(ports.value.provides(shellParserPort)).toBe(true);
    expect(ports.value.get(shellParserPort).ok).toBe(true);
  });

  test("the provisions are frozen", () => {
    const provisions = pathGatePortProvisions(mkdtempSync(join(tmpdir(), "port-provisions-state-")));
    expect(provisions.length).toBe(4);
    expect(Object.isFrozen(provisions)).toBe(true);
  });
});
