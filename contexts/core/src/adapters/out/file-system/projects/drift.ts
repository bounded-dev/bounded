import type { ProjectDrift, ShellSnapshots, WatchedFiles } from "bounded/application";
import { FileSystemShellSnapshots } from "../drift/snapshots.ts";
import { FileSystemWatchedFiles } from "../drift/watched-files.ts";

/** Each project's files on disk, and its snapshots in `.bounded/snapshots/`. */
export class FileSystemProjectDrift implements ProjectDrift {
  forProject(root: string): { readonly files: WatchedFiles; readonly snapshots: ShellSnapshots } {
    return { files: new FileSystemWatchedFiles(root), snapshots: new FileSystemShellSnapshots(root) };
  }
}
