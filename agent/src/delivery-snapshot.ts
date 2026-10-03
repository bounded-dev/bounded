// What a ticket worktree held when its deliver gate passed (ADR 2026-066).
// The deliver gate's pass is evidence about one tree; `bounded lead merge`
// may merge only that tree. The snapshot is two git object hashes: the tree
// the whole worktree would commit as (tracked and untracked files, ignore
// rules applied) and the tree of its index. Any write after delivery changes
// one of them, and merge refuses.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DELIVERY_SNAPSHOT_RELATIVE = ".bounded/delivery-snapshot.json";

export interface DeliverySnapshot {
  readonly tree: string;
  readonly index: string;
}

function gitTree(cwd: string, env: NodeJS.ProcessEnv, ...steps: string[][]): string {
  for (const args of steps) {
    const run = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(run.stderr ?? "").trim().slice(0, 300)}`);
    if (args[0] === "write-tree") return run.stdout.trim();
  }
  throw new Error("no tree was written");
}

/** The worktree's content and index, as tree hashes. Never changes the real index. */
export function worktreeSnapshot(cwd: string): DeliverySnapshot {
  const index = gitTree(cwd, process.env, ["write-tree"]);
  const scratch = mkdtempSync(join(tmpdir(), "bounded-snapshot-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
    const tree = gitTree(cwd, env, ["read-tree", "HEAD"], ["add", "-A"], ["write-tree"]);
    return { tree, index };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function recordDeliverySnapshot(cwd: string): DeliverySnapshot {
  const snapshot = worktreeSnapshot(cwd);
  writeFileSync(join(cwd, DELIVERY_SNAPSHOT_RELATIVE), JSON.stringify(snapshot, null, 2) + "\n");
  return snapshot;
}

export function readDeliverySnapshot(cwd: string): DeliverySnapshot | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, DELIVERY_SNAPSHOT_RELATIVE), "utf8")) as DeliverySnapshot;
    return typeof raw.tree === "string" && typeof raw.index === "string" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function clearDeliverySnapshot(cwd: string): void {
  rmSync(join(cwd, DELIVERY_SNAPSHOT_RELATIVE), { force: true });
}
