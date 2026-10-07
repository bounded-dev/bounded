import type { Result } from "../shared/result.ts";
import type * as Contract from "./project-path.contract.ts";

const URL_FORM = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const ABSOLUTE = /^([/~]|[A-Za-z]:(\/|$))/;
const isControl = (char: string): boolean => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f;

function parse(raw: unknown): Result<ProjectPath> {
  if (typeof raw !== "string") return { ok: false, error: "A path must be a string" };
  const path = raw.normalize("NFC");
  if (path === "") return { ok: false, error: "A path must not be empty. Use '.' for the project root" };
  if (path.includes("\0")) return { ok: false, error: "A path must not contain a NUL character" };
  if ([...path].some(isControl)) return { ok: false, error: "A path must not contain a control character" };
  if (path.includes("\\")) return { ok: false, error: `Path '${raw}' contains '\\'. Separate its parts with '/'` };
  if (URL_FORM.test(path)) return { ok: false, error: `Path '${raw}' is a URL. Give a path relative to the project root, such as 'src/a.ts'` };
  if (ABSOLUTE.test(path)) return { ok: false, error: `Path '${raw}' is absolute. Give it relative to the project root, such as 'src/a.ts'` };
  const segments: string[] = [];
  for (const segment of path.split("/")) {
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
export const ProjectPath: Contract.ProjectPathFactory = Object.freeze({ parse });
