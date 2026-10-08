import { shellSnapshotsConformance } from "./watch-shell.shell-snapshots.test-support.ts";
import { InMemoryShellSnapshots } from "./watch-shell.in-memory-shell-snapshots.test-support.ts";

shellSnapshotsConformance("InMemoryShellSnapshots", async () => new InMemoryShellSnapshots());
