import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellSnapshotsConformance } from "../../../../application/drift/watch-shell/watch-shell.snapshots.test-support.ts";
import { FileSystemShellSnapshots } from "./snapshots.ts";

// Hooks run as separate processes, so snapshots live in files: a new
// instance over the same root must see what another saved.
shellSnapshotsConformance("FileSystemShellSnapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "snapshots-"));
  const writer = new FileSystemShellSnapshots(root);
  const reader = new FileSystemShellSnapshots(root);
  return { save: (id, hashes) => writer.save(id, hashes), take: (id) => reader.take(id) };
});
