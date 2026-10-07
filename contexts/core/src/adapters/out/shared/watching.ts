import type { WatchedPath } from "bounded/domain";
import picomatch from "picomatch";

// How watched paths meet files, for every WatchedFiles adapter: picomatch,
// which runs on any JavaScript runtime. A rule's match ignores case, as the
// path gate's does, so a protected file cannot be dodged by its case on a
// case-insensitive file system; its except is exact, so a carve-out never
// grows. Version control's and bounded's own directories are never watched,
// nor anything inside node_modules: drift does not protect dependencies.

const MATCH = { dot: true, nocase: true, noextglob: true } as const;
const EXCEPT = { dot: true, noextglob: true } as const;

/** Whether `path` is, or is inside, .bounded at the root, or a node_modules or .git directory at any depth: never watched. */
export const isOwnState = (path: string): boolean => path === ".bounded" || path.startsWith(".bounded/") || path.split("/").some((part) => part === "node_modules" || part === ".git");

/** Whether a text holds a control character, such as a newline. */
const hasControl = (text: string): boolean => [...text].some((char) => char < " " || char === "\u007f");

/** Whether a path lies within a rule's fixed leading folder (compared ignoring case); every path does when it has none. */
const within = (base: string, path: string): boolean => base === "" || path.toLowerCase() === base || path.toLowerCase().startsWith(`${base}/`);

/**
 * For `rules`: the index of the first rule that watches a path, or -1 when
 * none does. picomatch never matches a control character such as a newline,
 * so a path holding one is watched conservatively: by the first rule whose
 * fixed leading folder holds it, its exceptions aside.
 */
export function watcher(rules: readonly WatchedPath[]): (path: string) => number {
  const compiled = rules.map((rule) => ({
    match: picomatch(rule.match, MATCH),
    except: (rule.except ?? []).map((except) => picomatch(except, EXCEPT)),
    base: picomatch.scan(rule.match).base.toLowerCase(),
  }));
  return (path) => {
    if (isOwnState(path)) return -1;
    if (hasControl(path)) return compiled.findIndex(({ base }) => within(base, path));
    return compiled.findIndex(({ match, except }) => match(path) && !except.some((test) => test(path)));
  };
}

/**
 * For `rules`: whether a directory may hold a watched file, so a walk need
 * not enter the others. A directory may when it and a rule's fixed leading
 * part (its base, compared ignoring case) lie on one path.
 */
export function mayHold(rules: readonly WatchedPath[]): (dir: string) => boolean {
  const bases = rules.map((rule) => picomatch.scan(rule.match).base.toLowerCase());
  return (dir) => !isOwnState(dir) && bases.some((base) => within(base, dir) || base.startsWith(`${dir.toLowerCase()}/`));
}

/** Whether `path` is a plain project-relative path: not absolute, without '..' or empty parts. */
export const isInside = (path: string): boolean => path !== "" && !path.startsWith("/") && !path.split("/").some((part) => part === ".." || part === "" || part === ".");
