import { homedir } from "node:os";
import { join } from "node:path";
import type { ProjectDrift, ShellSnapshots, WatchedFiles } from "bounded/application";
import { FileSystemShellSnapshots } from "./snapshots.ts";
import { stateDirFor, stateHomeFor } from "./state-home.ts";
import { FileSystemWatchedFiles } from "./watched-files.ts";

/** Each project's files on disk, its snapshots and what commands created (moved aside, never deleted) in the user's state directory. */
export class FileSystemProjectDrift implements ProjectDrift {
  private readonly stateHome: string;

  constructor(stateHome?: string) {
    this.stateHome = stateHome ?? stateHomeFor(process.env, homedir());
  }

  forProject(projectRoot: string): { readonly files: WatchedFiles; readonly snapshots: ShellSnapshots } {
    return { files: new FileSystemWatchedFiles(projectRoot, join(stateDirFor(this.stateHome, projectRoot), "quarantine")), snapshots: new FileSystemShellSnapshots(projectRoot, this.stateHome) };
  }
}
