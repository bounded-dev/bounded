import { type PortProvision, Ports } from "bounded/domain";
import { type ShellSnapshots, shellSnapshotsPort, type WatchedFiles, watchedFilesPort } from "../../../application/watch-shell/watch-shell.contract.ts";

/** The path gate's ports held in memory, for tests and hosts whose hooks share one process: the same adapters for every project. */
export function pathGateInMemory(files: WatchedFiles, snapshots: ShellSnapshots): readonly PortProvision[] {
  return Object.freeze([Ports.provide(watchedFilesPort, () => files), Ports.provide(shellSnapshotsPort, () => snapshots)]);
}
