// Where a pi path argument really acts. pi rewrites a path before using it,
// then resolves it lexically against a directory; this does the same, keeps
// the result inside the project, and follows links to where they land.
// POSIX paths only: pi's Windows rewrites (drive letters, '~\\') are not mirrored.
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type ProjectPath as Path, ProjectPath, type Result } from "bounded/domain";

/** The spaces pi turns into " " (normalizePath in pi's utils/paths.js). */
const UNICODE_SPACES = /[  -   　]/g;

/**
 * pi's rewrite of a path argument, in pi's order: unicode spaces to " ",
 * one leading '@' stripped, '~' and '~/' expanded, a file:// URL decoded.
 */
export function piRewrite(raw: string, home: string): Result<string> {
  let path = raw.replace(UNICODE_SPACES, " ");
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") return { ok: true, value: home };
  if (path.startsWith("~/")) return { ok: true, value: join(home, path.slice(2)) };
  if (!path.startsWith("file://")) return { ok: true, value: path };
  try {
    return { ok: true, value: fileURLToPath(path) };
  } catch (error) {
    return { ok: false, error: `Path '${raw}' is a file URL that cannot be decoded (${String(error)})` };
  }
}

/** A located path: project-relative, the real absolute path pi acts on, and whether it exists. */
export interface Located {
  readonly path: Path;
  readonly absolute: string;
  readonly exists: boolean;
}

/**
 * Locates a pi path argument given relative to `base` (an absolute
 * directory). A "read" is located as pi's read tool opens it, fallback
 * spellings included.
 */
export type Locate = (raw: string, base: string, use?: "read") => Result<Located>;

/**
 * The spelling pi's read opens (resolveReadPath in pi's tools/path-utils.js):
 * the path if it exists, else the first that exists of a narrow no-break
 * space before AM/PM, the NFD form, a curly apostrophe, and NFD with a curly
 * apostrophe, each over the whole absolute path. Existence follows links.
 */
function piReadSpelling(absolute: string): string {
  if (existsSync(absolute)) return absolute;
  const nfd = absolute.normalize("NFD");
  const curly = (path: string): string => path.replace(/'/g, "\u2019");
  const variants = [absolute.replace(/ (AM|PM)\./gi, "\u202F$1."), nfd, curly(absolute), curly(nfd)];
  return variants.find((variant) => variant !== absolute && existsSync(variant)) ?? absolute;
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const within = (root: string, path: string): string | undefined => {
  const inner = relative(root, path);
  return inner === ".." || inner.startsWith(`..${sep}`) || isAbsolute(inner) ? undefined : inner;
};

/**
 * The real path `absolute` lands on: its deepest existing part through the
 * native realpath (which, unlike node's JS one, returns the stored case on a
 * case-insensitive volume), then the rest as written. A dangling link has no
 * real path, so it is refused: writing through it would create its target,
 * wherever that is. So is a loop of links.
 */
function landing(raw: string, absolute: string): Result<{ real: string; exists: boolean }> {
  let existing = absolute;
  const rest: string[] = [];
  while (!exists(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  try {
    return { ok: true, value: { real: join(realpathSync.native(existing), ...rest), exists: rest.length === 0 } };
  } catch (error) {
    const loop = error instanceof Error && "code" in error && error.code === "ELOOP";
    return { ok: false, error: loop ? `Path '${raw}' goes through a loop of links (${existing})` : `Path '${raw}' goes through a link whose target does not exist (${existing})` };
  }
}

/** The locator for a project: pi's rewrite, then lexically inside the project, then where links land. */
export function locator(root: string, home: string = homedir()): Locate {
  return (raw, base, use) => {
    if (raw.includes("\0")) return { ok: false, error: "A path must not contain a NUL character" };
    let realRoot: string;
    try {
      realRoot = realpathSync.native(root);
    } catch {
      return { ok: false, error: `The project root ${root} cannot be found` };
    }
    const rewritten = piRewrite(raw, home);
    if (!rewritten.ok) return rewritten;
    const resolved = resolve(base, rewritten.value);
    const absolute = use === "read" ? piReadSpelling(resolved) : resolved;
    if (within(root, absolute) === undefined && within(realRoot, absolute) === undefined) {
      return { ok: false, error: `Path '${raw}' is ${absolute}, outside the project` };
    }
    const landed = landing(raw, absolute);
    if (!landed.ok) return landed;
    const inner = within(realRoot, landed.value.real);
    if (inner === undefined) return { ok: false, error: `Path '${raw}' leads through a link to ${landed.value.real}, outside the project` };
    const path = ProjectPath.parse(inner.split(sep).join("/") || ".");
    return path.ok ? { ok: true, value: { path: path.value, absolute: landed.value.real, exists: landed.value.exists } } : path;
  };
}
