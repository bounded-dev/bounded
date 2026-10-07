import type { Result } from "../shared/result.ts";

/**
 * A path inside the project, relative to its root and normalised: segments
 * joined by '/', without '.', empty segments or '..'. The root is ".". The
 * host adapter resolves the host's own paths (rewriting, links) before
 * building one; this only checks and normalises. Branded.
 */
export type ProjectPath = string & { readonly __projectPath: true };

export interface ProjectPathFactory {
  /** The normalised path, or why the value is not a path inside the project. */
  parse(raw: unknown): Result<ProjectPath>;
}
