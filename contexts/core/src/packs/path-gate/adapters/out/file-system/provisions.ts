import { homedir } from "node:os";
import { join } from "node:path";
import { type PortProvision, Ports } from "bounded/domain";
import { shellSnapshotsPort, watchedFilesPort } from "../../../application/watch-shell/watch-shell.contract.ts";
import { FileSystemShellSnapshots } from "./snapshots.ts";
import { stateDirFor, stateHomeFor } from "./state-home.ts";
import { FileSystemWatchedFiles } from "./watched-files.ts";

/**
 * The path gate's ports on disk, for a host's composition root: each
 * project's files, its snapshots and what commands created (moved aside,
 * never deleted) in the user's state directory,
 * `<stateHome>/bounded/<sha256 of the root>/`. `stateHome` defaults to
 * $XDG_STATE_HOME, else ~/.local/state.
 */
export function pathGateFileSystem(stateHome: string = stateHomeFor(process.env, homedir())): readonly PortProvision[] {
  return Object.freeze([
    Ports.provide(watchedFilesPort, (projectRoot) => new FileSystemWatchedFiles(projectRoot, join(stateDirFor(stateHome, projectRoot), "quarantine"))),
    Ports.provide(shellSnapshotsPort, (projectRoot) => new FileSystemShellSnapshots(projectRoot, stateHome)),
  ]);
}
