import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { ProjectPath } from "bounded/domain";
import type { PathKind, PathKinds } from "../../../application/judge-calls/judge-calls.contract.ts";

/** What is at a path in a project on disk; a link is never followed. Undefined when the disk cannot say. */
export class FileSystemPathKinds implements PathKinds {
  constructor(private readonly projectRoot: string) {}

  kindOf(path: ProjectPath): PathKind | undefined {
    try {
      const found = lstatSync(join(this.projectRoot, path.value), { throwIfNoEntry: false });
      if (found === undefined) return "absent";
      return found.isFile() ? "file" : found.isDirectory() ? "directory" : "other";
    } catch {
      return undefined;
    }
  }
}
