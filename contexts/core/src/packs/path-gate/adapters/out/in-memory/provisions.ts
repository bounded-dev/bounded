import { type PortProvision, Ports } from "bounded/domain";
import { type PathKinds, pathKindsPort } from "../../../application/judge-calls/judge-calls.contract.ts";
import { type ShellSnapshots, shellSnapshotsPort, type WatchedFiles, watchedFilesPort } from "../../../application/watch-shell/watch-shell.contract.ts";

/** The path gate's ports held in memory, for tests and hosts whose hooks share one process: the same adapters for every project. */
export function pathGateInMemory(adapters: { readonly watchedFiles: WatchedFiles; readonly shellSnapshots: ShellSnapshots; readonly pathKinds: PathKinds }): readonly PortProvision[] {
  return Object.freeze([
    Ports.provide(watchedFilesPort, () => adapters.watchedFiles),
    Ports.provide(shellSnapshotsPort, () => adapters.shellSnapshots),
    Ports.provide(pathKindsPort, () => adapters.pathKinds),
  ]);
}
