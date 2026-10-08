import { homedir } from "node:os";
import { join } from "node:path";
import { type PortProvision, Ports } from "bounded/domain";
import { shellSnapshotsPort, watchedFilesPort } from "../../application/watch-shell/watch-shell.contract.ts";
import { FileSystemShellSnapshots } from "./shell-snapshots/shell-snapshots.ts";
import { stateDirFor, stateHomeFor } from "./state-directory.ts";
import { FileSystemWatchedFiles } from "./watched-files/watched-files.ts";

/**
 * Every port the path gate uses, for a host's composition root: each
 * project's files, its snapshots and what commands created (moved aside,
 * never deleted) in the user's state directory,
 * `<stateHome>/bounded/<sha256 of the root>/`. `stateHome` defaults to
 * $XDG_STATE_HOME, else ~/.local/state. Shell commands are read by the
 * shell command reader the host passes to openProject (ADR 2026-020), not by
 * a port of the path gate.
 */
export function pathGatePortProvisions(stateHome: string = stateHomeFor(process.env, homedir())): readonly PortProvision[] {
  return Object.freeze([
    Ports.provide(watchedFilesPort, (projectRoot) => new FileSystemWatchedFiles(projectRoot, join(stateDirFor(stateHome, projectRoot), "quarantine"))),
    Ports.provide(shellSnapshotsPort, (projectRoot) => new FileSystemShellSnapshots(projectRoot, stateHome)),
  ]);
}
