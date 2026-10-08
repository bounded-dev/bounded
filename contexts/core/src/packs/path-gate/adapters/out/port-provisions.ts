import { homedir } from "node:os";
import { join } from "node:path";
import { type PortProvision, Ports } from "bounded/domain";
import { pathKindsPort, shellParserPort } from "../../application/judge-calls/judge-calls.contract.ts";
import { shellSnapshotsPort, watchedFilesPort } from "../../application/watch-shell/watch-shell.contract.ts";
import { FileSystemPathKinds } from "./path-kinds/path-kinds.ts";
import { TreeSitterShellParser } from "./shell-parser/shell-parser.ts";
import { FileSystemShellSnapshots } from "./shell-snapshots/shell-snapshots.ts";
import { stateDirFor, stateHomeFor } from "./state-directory.ts";
import { FileSystemWatchedFiles } from "./watched-files/watched-files.ts";

/**
 * Every port the path gate uses, for a host's composition root: what is at
 * each project's paths, its files, its snapshots and what commands created
 * (moved aside, never deleted) in the user's state directory,
 * `<stateHome>/bounded/<sha256 of the root>/`, and the shell parser,
 * tree-sitter's bash grammar (a parser per project, the grammar loaded once
 * per process). `stateHome` defaults to $XDG_STATE_HOME, else ~/.local/state.
 */
export function pathGatePortProvisions(stateHome: string = stateHomeFor(process.env, homedir())): readonly PortProvision[] {
  return Object.freeze([
    Ports.provide(watchedFilesPort, (projectRoot) => new FileSystemWatchedFiles(projectRoot, join(stateDirFor(stateHome, projectRoot), "quarantine"))),
    Ports.provide(shellSnapshotsPort, (projectRoot) => new FileSystemShellSnapshots(projectRoot, stateHome)),
    Ports.provide(pathKindsPort, (projectRoot) => new FileSystemPathKinds(projectRoot)),
    Ports.provide(shellParserPort, () => new TreeSitterShellParser()),
  ]);
}
