import type { Result } from "../shared/result.ts";
import type * as Contract from "./project-path.contract.ts";

const ABSOLUTE = /^([/~]|[A-Za-z]:)/;

function parse(raw: unknown): Result<ProjectPath> {
  if (typeof raw !== "string") return { ok: false, error: "A path must be a string" };
  if (raw === "") return { ok: false, error: "A path must not be empty. Use '.' for the project root" };
  if (raw.includes("\0")) return { ok: false, error: "A path must not contain a NUL character" };
  if (raw.includes("\\")) return { ok: false, error: `Path '${raw}' contains '\\'. Separate its parts with '/'` };
  if (ABSOLUTE.test(raw)) return { ok: false, error: `Path '${raw}' is absolute. Give it relative to the project root, such as 'src/a.ts'` };
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.pop() === undefined) {
      return { ok: false, error: `Path '${raw}' climbs out of the project with '..'. Only paths inside the project can be checked` };
    }
  }
  // The brand exists only in types; the normalised text is the path.
  return { ok: true, value: (segments.join("/") || ".") as ProjectPath };
}

export type ProjectPath = Contract.ProjectPath;
export const ProjectPath: Contract.ProjectPathFactory = { parse };
