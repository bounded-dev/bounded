import { shellSnapshotsConformance } from "../../../../application/drift/watch-shell/watch-shell.snapshots.test-support.ts";
import { InMemoryShellSnapshots } from "./snapshots.ts";

shellSnapshotsConformance("InMemoryShellSnapshots", async () => new InMemoryShellSnapshots());
