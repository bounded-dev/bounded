import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { ProjectPath } from "bounded/domain";
import type { PathKind } from "../../../domain/shell-command.contract.ts";

/** What is at `path` in the project at `projectRoot`, on disk; a link is never followed. Undefined when the disk cannot say. */
export function fileSystemPathKind(projectRoot: string, path: ProjectPath): PathKind | undefined {
  try {
    const found = lstatSync(join(projectRoot, path.value), { throwIfNoEntry: false });
    if (found === undefined) return "absent";
    return found.isFile() ? "file" : found.isDirectory() ? "directory" : "other";
  } catch {
    return undefined;
  }
}
