import type { Composition } from "../composition/composition.contract.ts";

/** What is at a project path: a file, a directory, something else (such as a link, never followed), or nothing. */
export type PathKind = "file" | "directory" | "other" | "absent";

/**
 * A project as it opens, for the packs that prepare for it: its root (an
 * absolute path) and a way to ask what is at a project-relative path, which
 * answers undefined when it cannot tell.
 */
export interface OpenedProject {
  readonly root: string;
  kindOfPath(path: string): PathKind | undefined;
}

/**
 * What a pack does once when a project opens, before any event is judged,
 * such as loading what its guards need. Given the project and the
 * composition its guards will be called with. If it fails, the project
 * still opens: the pack's own guards answer for it, refusing what they
 * cannot check.
 */
export type ProjectOpenHandler = (project: OpenedProject, composition: Composition) => Promise<void>;
