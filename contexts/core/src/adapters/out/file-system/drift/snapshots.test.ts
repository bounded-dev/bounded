import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellSnapshotsConformance } from "../../../../application/drift/watch-shell/watch-shell.snapshots.test-support.ts";
import { FileSystemProjectDrift } from "./project-drift.ts";
import { stateHomeFor } from "./state-home.ts";
import { FileSystemShellSnapshots } from "./snapshots.ts";

// Hooks run as separate processes, so snapshots live in files: a new
// instance over the same root must see what another saved.
shellSnapshotsConformance("FileSystemShellSnapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "snapshots-"));
  const state = mkdtempSync(join(tmpdir(), "snapshots-state-"));
  const writer = new FileSystemShellSnapshots(root, state);
  const reader = new FileSystemShellSnapshots(root, state);
  return { save: (id, snapshot) => writer.save(id, snapshot), take: (id) => reader.take(id) };
});

describe("FileSystemShellSnapshots — kept away from the project, and not for long", () => {
  const snapshot = { commit: null, files: {} };
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "snapshots-"));
    const state = mkdtempSync(join(tmpdir(), "snapshots-state-"));
    const dir = join(state, "bounded", createHash("sha256").update(root).digest("hex"), "snapshots");
    return { root, state, dir, snapshots: new FileSystemShellSnapshots(root, state) };
  }

  test("keeps snapshots in the user's state directory, by project, readable by their owner only; nothing in the project", async () => {
    const { root, dir, snapshots } = setup();
    await snapshots.save("c1", snapshot);
    const [file] = readdirSync(dir);
    expect(file).toBeDefined();
    expect(statSync(join(dir, file ?? "")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "..")).mode & 0o777).toBe(0o700);
    expect(existsSync(join(root, ".bounded"))).toBe(false);
  });

  test("a snapshot older than a day is never given back, and is removed", async () => {
    const { dir, snapshots } = setup();
    await snapshots.save("old", snapshot);
    const [file] = readdirSync(dir);
    const dayAndAnHourAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(join(dir, file ?? ""), dayAndAnHourAgo, dayAndAnHourAgo);
    expect(await snapshots.take("old")).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("saving sweeps away snapshots older than a day, such as those of calls the host never finished", async () => {
    const { dir, snapshots } = setup();
    await snapshots.save("abandoned", snapshot);
    const [old] = readdirSync(dir);
    const dayAndAnHourAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(join(dir, old ?? ""), dayAndAnHourAgo, dayAndAnHourAgo);
    await snapshots.save("next", snapshot);
    expect(readdirSync(dir)).not.toContain(old);
    expect(readdirSync(dir).length).toBe(1);
  });

  test("a snapshot file that is not JSON makes take reject, so the handler treats it as altered", async () => {
    const { dir, snapshots } = setup();
    await snapshots.save("c1", snapshot);
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file ?? ""), "{garbled");
    await expect(snapshots.take("c1")).rejects.toThrow();
  });

  test("the state directory is $XDG_STATE_HOME when absolute, else ~/.local/state", () => {
    expect(stateHomeFor({ XDG_STATE_HOME: "/state" }, "/home/me")).toBe("/state");
    expect(stateHomeFor({ XDG_STATE_HOME: "relative" }, "/home/me")).toBe("/home/me/.local/state");
    expect(stateHomeFor({}, "/home/me")).toBe("/home/me/.local/state");
  });

  test("a project's drift adapters keep its snapshots under the given state directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "snapshots-"));
    const state = mkdtempSync(join(tmpdir(), "snapshots-state-"));
    await new FileSystemProjectDrift(state).forProject(root).snapshots.save("c1", snapshot);
    expect(readdirSync(join(state, "bounded")).length).toBe(1);
  });
});
