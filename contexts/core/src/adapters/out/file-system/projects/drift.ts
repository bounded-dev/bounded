import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ProjectDrift, ShellSnapshots, WatchedFiles } from "bounded/application";
import { FileSystemShellSnapshots, stateDirFor } from "../drift/snapshots.ts";
import { FileSystemWatchedFiles } from "../drift/watched-files.ts";

/** The user's state directory: $XDG_STATE_HOME when it is absolute, else ~/.local/state. */
export function stateHomeFor(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const given = env.XDG_STATE_HOME;
  return given !== undefined && isAbsolute(given) ? given : join(home, ".local", "state");
}

/** Each project's files on disk, its snapshots and what commands created (moved aside, never deleted) in the user's state directory. */
export class FileSystemProjectDrift implements ProjectDrift {
  private readonly stateHome: string;

  constructor(stateHome?: string) {
    this.stateHome = stateHome ?? stateHomeFor(process.env, homedir());
  }

  forProject(root: string): { readonly files: WatchedFiles; readonly snapshots: ShellSnapshots } {
    return { files: new FileSystemWatchedFiles(root, join(stateDirFor(this.stateHome, root), "quarantine")), snapshots: new FileSystemShellSnapshots(root, this.stateHome) };
  }
}
