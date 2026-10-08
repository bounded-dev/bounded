import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { ProjectPathKinds } from "bounded/application";
import type { PathKind, ProjectPath } from "bounded/domain";

/** What is at a path in each project on disk; a link is never followed. Undefined when the disk cannot say. */
export class FileSystemProjectPathKinds implements ProjectPathKinds {
  forProject(projectRoot: string): (path: ProjectPath) => PathKind | undefined {
    return (path) => {
      try {
        const found = lstatSync(join(projectRoot, path.value), { throwIfNoEntry: false });
        if (found === undefined) return "absent";
        return found.isFile() ? "file" : found.isDirectory() ? "directory" : "other";
      } catch {
        return undefined;
      }
    };
  }
}
