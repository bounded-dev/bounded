import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { ProjectPathKinds } from "bounded/application";
import type { PathKind } from "bounded/domain";

/** Whether `path` is a plain project-relative path: not absolute, without '..' or empty parts. */
const isProjectPath = (path: string): boolean => path === "." || (path !== "" && !path.startsWith("/") && !path.split("/").some((part) => part === "" || part === ".."));

/** What is at a path in each project on disk; a link is never followed. */
export class FileSystemProjectPathKinds implements ProjectPathKinds {
  forProject(root: string): (path: string) => PathKind | undefined {
    return (path) => {
      if (!isProjectPath(path)) return undefined;
      try {
        const found = lstatSync(join(root, path), { throwIfNoEntry: false });
        if (found === undefined) return "absent";
        return found.isFile() ? "file" : found.isDirectory() ? "directory" : "other";
      } catch {
        return undefined;
      }
    };
  }
}
