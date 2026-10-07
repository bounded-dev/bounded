// The file-system side of path resolution: the PathResolver port's adapter.
// A Claude Code path is refused in forms Claude Code does not expand, then
// judged by where it really lands: its existing components are resolved with
// realpath, so a link counts as its target, and the result must be inside the
// project. A path that does not exist yet is judged by its nearest existing
// parent, its missing tail keeping the case it was written in; a link to
// nothing is refused. Limits: a hard link cannot be told from its target, and
// the file system can change between this check and the tool's use of it.
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Refuse, type Result, Verdict } from "bounded/domain";
import type { PathResolver } from "./event.ts";

const REDIRECT = "Use a path inside the project; a link must land inside it too";
const HOST_FORMS = ["~", "@", "file:"];

const refuse = (reason: string): { ok: false; error: Refuse } => ({ ok: false, error: Verdict.refuse(reason, REDIRECT) });
const message = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

/** `path` relative to `root`, '/'-separated, or null when it is not inside it. */
function inside(path: string, root: string): string | null {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel === "" ? "." : rel.split(sep).join("/");
}

/** Where `path` really is: its longest existing prefix through realpath, then the rest as written. */
function realLocation(path: string): Result<{ real: string; exists: boolean }, string> {
  const rest: string[] = [];
  for (let head = path; ; head = dirname(head)) {
    try {
      return { ok: true, value: { real: join(realpathSync.native(head), ...rest), exists: rest.length === 0 } };
    } catch (thrown) {
      const code = (thrown as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return { ok: false, error: `cannot be read: ${message(thrown)}` };
    }
    // The entry is there but realpath cannot follow it: a link to nothing,
    // where a write would create a file wherever it points.
    if (entryExists(head)) return { ok: false, error: "is a link to something that does not exist, so where it lands cannot be judged" };
    if (dirname(head) === head) return { ok: false, error: "has no existing directory above it" };
    rest.unshift(basename(head));
  }
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The resolver for one project: `projectDir` is Claude Code's CLAUDE_PROJECT_DIR. */
export function projectPaths(projectDir: string): PathResolver {
  return {
    resolve(given, cwd) {
      // Claude Code trims a path (String.prototype.trim) before it uses it: judge what it uses.
      const raw = given.trim();
      if (raw === "") return refuse("A path must not be empty");
      if (raw.includes("\0")) return refuse("A path must not contain a NUL character");
      const form = HOST_FORMS.find((prefix) => raw.startsWith(prefix));
      if (form !== undefined) return refuse(`Path '${raw}' starts with '${form}'. Give the path itself: absolute under the project, or relative to it`);
      let realRoot: string;
      try {
        realRoot = realpathSync.native(projectDir);
      } catch (thrown) {
        return refuse(`The project directory '${projectDir}' cannot be read: ${message(thrown)}`);
      }
      const target = resolve(cwd, raw);
      const location = realLocation(target);
      if (!location.ok) return refuse(`Path '${raw}' ${location.error}`);
      // Where the path really lands is what is judged; how it is written only chooses the message.
      const path = inside(location.value.real, realRoot);
      if (path !== null) return { ok: true, value: { path, exists: location.value.exists } };
      const written = inside(target, projectDir) ?? inside(target, realRoot);
      if (written === null) return refuse(`Path '${raw}' is outside the project at '${projectDir}'`);
      return refuse(`Path '${raw}' is a link that lands outside the project, at '${location.value.real}'`);
    },
  };
}
