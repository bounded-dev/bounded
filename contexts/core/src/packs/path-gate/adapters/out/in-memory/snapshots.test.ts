import { shellSnapshotsConformance } from "../../../application/watch-shell/watch-shell.snapshots.test-support.ts";
import { InMemoryShellSnapshots } from "./snapshots.ts";

shellSnapshotsConformance("InMemoryShellSnapshots", async () => new InMemoryShellSnapshots());
