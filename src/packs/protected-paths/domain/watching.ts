import picomatch from "picomatch";
import type * as Contract from "./watching.contract.ts";

// picomatch, which runs on any JavaScript runtime (see the contract).

const MATCH = { dot: true, nocase: true, noextglob: true } as const;
const EXCEPT = { dot: true, noextglob: true } as const;

/** Whether `path` is, or is inside, .bounded at the root, or a node_modules or .git directory at any depth: never watched. */
export const isOwnState: Contract.IsOwnState = (path) => path === ".bounded" || path.startsWith(".bounded/") || path.split("/").some((part) => part === "node_modules" || part === ".git");

/** Whether a text holds a control character, such as a newline. */
const hasControl = (text: string): boolean => [...text].some((char) => char < " " || char === "\u007f");

/** Whether a path lies within a rule's fixed leading folder (compared ignoring case); every path does when it has none. */
const within = (base: string, path: string): boolean => base === "" || path.toLowerCase() === base || path.toLowerCase().startsWith(`${base}/`);

/**
 * For `rules`: the indexes of every rule that watches a path, in order;
 * none when no rule does. picomatch never matches a control character such
 * as a newline, so a path holding one is watched conservatively: by every
 * rule whose fixed leading folder holds it, exceptions aside.
 */
export const watcher: Contract.Watcher = (rules) => {
  const compiled = rules.map((rule) => ({
    match: picomatch(rule.match, MATCH),
    except: (rule.except ?? []).map((except) => picomatch(except, EXCEPT)),
    base: picomatch.scan(rule.match).base.toLowerCase(),
  }));
  return (path) => {
    if (isOwnState(path)) return [];
    const watches = hasControl(path) ? ({ base }: (typeof compiled)[number]) => within(base, path) : ({ match, except }: (typeof compiled)[number]) => match(path) && !except.some((test) => test(path));
    return compiled.flatMap((rule, index) => (watches(rule) ? [index] : []));
  };
};

/** A watched file's rule fields from the rules that watch it: the first as its rule, all of them when there are several. */
export const ruleFields: Contract.RuleFields = (by) => ({ rule: by[0] ?? -1, ...(by.length > 1 ? { rules: by } : {}) });

/**
 * For `rules`: whether a directory may hold a watched file, so a walk need
 * not enter the others. A directory may when it and a rule's fixed leading
 * part (its base, compared ignoring case) lie on one path.
 */
export const mayHold: Contract.MayHold = (rules) => {
  const bases = rules.map((rule) => picomatch.scan(rule.match).base.toLowerCase());
  return (dir) => !isOwnState(dir) && bases.some((base) => within(base, dir) || base.startsWith(`${dir.toLowerCase()}/`));
};

/** Whether `path` is a plain project-relative path: not absolute, without '..' or empty parts. */
export const isInside: Contract.IsInside = (path) => path !== "" && !path.startsWith("/") && !path.split("/").some((part) => part === ".." || part === "" || part === ".");
