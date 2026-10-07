import type { WatchedPath } from "bounded/domain";
import picomatch from "picomatch";

// How watched paths meet files, for every WatchedFiles adapter: picomatch,
// which runs on any JavaScript runtime. A rule's match ignores case, as the
// path gate's does, so a protected file cannot be dodged by its case on a
// case-insensitive file system; its except is exact, so a carve-out never
// grows. Version control's and bounded's own directories are never watched.

const MATCH = { dot: true, nocase: true, noextglob: true } as const;
const EXCEPT = { dot: true, noextglob: true } as const;

/** Whether `path` is inside .git or .bounded, which bounded never watches. */
export const isOwnState = (path: string): boolean => [".git", ".bounded"].some((dir) => path === dir || path.startsWith(`${dir}/`));

/** For `rules`: the index of the first rule that watches a path, or -1 when none does. */
export function watcher(rules: readonly WatchedPath[]): (path: string) => number {
  const compiled = rules.map((rule) => ({ match: picomatch(rule.match, MATCH), except: (rule.except ?? []).map((except) => picomatch(except, EXCEPT)) }));
  return (path) => (isOwnState(path) ? -1 : compiled.findIndex(({ match, except }) => match(path) && !except.some((test) => test(path))));
}

/**
 * For `rules`: whether a directory may hold a watched file, so a walk need
 * not enter the others. A directory may when it and a rule's fixed leading
 * part (its base, compared ignoring case) lie on one path.
 */
export function mayHold(rules: readonly WatchedPath[]): (dir: string) => boolean {
  const bases = rules.map((rule) => picomatch.scan(rule.match).base.toLowerCase());
  return (dir) => {
    if (isOwnState(dir)) return false;
    const lower = dir.toLowerCase();
    return bases.some((base) => base === "" || base === lower || base.startsWith(`${lower}/`) || lower.startsWith(`${base}/`));
  };
}

/** Whether `path` is a plain project-relative path: not absolute, without '..' or empty parts. */
export const isInside = (path: string): boolean => path !== "" && !path.startsWith("/") && !path.split("/").some((part) => part === ".." || part === "" || part === ".");
