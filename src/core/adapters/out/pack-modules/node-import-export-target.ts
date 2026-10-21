/** Node ESM package exports resolution shared by catalogue build and managed artifact verification. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The conditions a host's import() matches under Node 22.18 and later, besides "default", which always matches. */
const HOST_IMPORT_CONDITIONS: ReadonlySet<string> = new Set(["node", "import", "module-sync"]);

/**
 * A `.`, `..` or `node_modules` segment, in any case and percent-encoded: Node's deprecatedInvalidSegmentRegEx, the
 * pattern it throws on. Its wider invalidSegmentRegEx also takes an empty segment, which Node only warns about, so an
 * empty segment alone is no refusal here either.
 */
const INVALID_SEGMENT = /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))(\\|\/|$)/i;

/** Node's Invalid Package Target error. */
class InvalidPackageTarget extends Error {
  constructor(readonly target: unknown) {
    super("Invalid Package Target");
  }
}
/** Node's Invalid Module Specifier error, for a pattern's match. */
class InvalidModuleSpecifier extends Error {
  constructor(readonly patternMatch: string) {
    super("Invalid Module Specifier");
  }
}
/** Node's Invalid Package Configuration error. */
class InvalidPackageConfiguration extends Error {
  constructor(readonly reason: string) {
    super("Invalid Package Configuration");
  }
}

export const isInvalidPackageTarget = (value: unknown): value is InvalidPackageTarget => value instanceof InvalidPackageTarget;
export const isInvalidModuleSpecifier = (value: unknown): value is InvalidModuleSpecifier => value instanceof InvalidModuleSpecifier;
export const isInvalidPackageConfiguration = (value: unknown): value is InvalidPackageConfiguration => value instanceof InvalidPackageConfiguration;

/** A package-relative target, null (not exported), or undefined (no condition matched): PACKAGE_TARGET_RESOLVE's results. */
type TargetResolution = string | null | undefined;

/** PACKAGE_TARGET_RESOLVE(packageURL, target, patternMatch, isImports = false, conditions), giving the package-relative target. */
function packageTargetResolve(target: unknown, patternMatch: string | null, conditions: ReadonlySet<string> = HOST_IMPORT_CONDITIONS): TargetResolution {
  // 1. A string: it starts with "./" (exports, isImports false), with no invalid segment after it.
  if (typeof target === "string") {
    if (!target.startsWith("./")) throw new InvalidPackageTarget(target);
    if (INVALID_SEGMENT.test(target.slice(2))) throw new InvalidPackageTarget(target);
    if (patternMatch === null) return target;
    if (INVALID_SEGMENT.test(patternMatch)) throw new InvalidModuleSpecifier(patternMatch);
    return target.replaceAll("*", patternMatch);
  }
  // 3. An array: each item in turn, skipping Invalid Package Target errors and items that give undefined or null;
  // the last null or error is the result (Node's implementation).
  if (Array.isArray(target)) {
    if (target.length === 0) return null;
    let last: InvalidPackageTarget | null | undefined;
    for (const item of target) {
      let resolved: TargetResolution;
      try {
        resolved = packageTargetResolve(item, patternMatch, conditions);
      } catch (thrown) {
        if (!(thrown instanceof InvalidPackageTarget)) throw thrown;
        last = thrown;
        continue;
      }
      if (resolved === undefined) continue;
      if (resolved === null) {
        last = null;
        continue;
      }
      return resolved;
    }
    if (last === undefined || last === null) return last;
    throw last;
  }
  // 4. null: not exported.
  if (target === null) return null;
  // 2. Conditions: no index keys; each key in the object's own order that is "default" or a host's condition; a
  // matched key that gives undefined goes on to the next.
  if (isRecord(target)) {
    if (Object.keys(target).some((key) => /^(0|[1-9][0-9]*)$/.test(key))) throw new InvalidPackageConfiguration("gives a condition object a numeric key");
    for (const [condition, value] of Object.entries(target)) {
      if (condition !== "default" && !conditions.has(condition)) continue;
      const resolved = packageTargetResolve(value, patternMatch, conditions);
      if (resolved === undefined) continue;
      return resolved;
    }
    return undefined;
  }
  // 5. Anything else.
  throw new InvalidPackageTarget(target);
}

/** PATTERN_KEY_COMPARE(keyA, keyB). */
function patternKeyCompare(keyA: string, keyB: string): number {
  const baseLengthA = keyA.includes("*") ? keyA.indexOf("*") + 1 : keyA.length;
  const baseLengthB = keyB.includes("*") ? keyB.indexOf("*") + 1 : keyB.length;
  if (baseLengthA > baseLengthB) return -1;
  if (baseLengthB > baseLengthA) return 1;
  if (!keyA.includes("*")) return 1;
  if (!keyB.includes("*")) return -1;
  if (keyA.length > keyB.length) return -1;
  if (keyB.length > keyA.length) return 1;
  return 0;
}

/** Whether a key of exports matched the export path, and if so what its target resolved to. */
type KeyMatch = { readonly matched: false } | { readonly matched: true; readonly resolved: TargetResolution };

/** PACKAGE_IMPORTS_EXPORTS_RESOLVE(matchKey, matchObj, packageURL, isImports = false, conditions). */
function packageImportsExportsResolve(matchKey: string, matchObj: Readonly<Record<string, unknown>>, conditions: ReadonlySet<string>): KeyMatch {
  // 1. An exact key with no "*"; Node's implementation also passes over a key ending in "/", the folder mappings
  // it removed.
  if (Object.hasOwn(matchObj, matchKey) && !matchKey.includes("*") && !matchKey.endsWith("/")) return { matched: true, resolved: packageTargetResolve(matchObj[matchKey], null, conditions) };
  // 2. The keys with a single "*", most specific first.
  const expansionKeys = Object.keys(matchObj)
    .filter((key) => key.indexOf("*") !== -1 && key.indexOf("*") === key.lastIndexOf("*"))
    .sort(patternKeyCompare);
  // 3. The first whose base and trailer the export path fits.
  for (const expansionKey of expansionKeys) {
    const patternBase = expansionKey.slice(0, expansionKey.indexOf("*"));
    if (!matchKey.startsWith(patternBase) || matchKey === patternBase) continue;
    const patternTrailer = expansionKey.slice(expansionKey.indexOf("*") + 1);
    if (patternTrailer.length === 0 || (matchKey.endsWith(patternTrailer) && matchKey.length >= expansionKey.length)) {
      const patternMatch = matchKey.slice(patternBase.length, matchKey.length - patternTrailer.length);
      return { matched: true, resolved: packageTargetResolve(matchObj[expansionKey], patternMatch, conditions) };
    }
  }
  // 4. No key matched.
  return { matched: false };
}

/** PACKAGE_EXPORTS_RESOLVE(packageURL, subpath, exports, conditions): what it gives, keeping apart a path exports does not list from one it lists but exports nothing for. */
export function packageExportsResolve(exports: unknown, subpath: string, conditions: ReadonlySet<string> = HOST_IMPORT_CONDITIONS): { readonly listed: false } | { readonly listed: true; readonly target: string | undefined } {
  const keys = isRecord(exports) ? Object.keys(exports) : [];
  const hasExportPaths = keys.some((key) => key.startsWith("."));
  // 1. Export paths and conditions are not mixed.
  if (hasExportPaths && keys.some((key) => !key.startsWith("."))) throw new InvalidPackageConfiguration("mixes export paths (keys starting with .) with conditions");
  // 2. The package root.
  if (subpath === ".") {
    let mainExport: unknown;
    if (typeof exports === "string" || Array.isArray(exports) || (isRecord(exports) && !hasExportPaths)) mainExport = exports;
    else if (isRecord(exports) && Object.hasOwn(exports, ".")) mainExport = exports["."];
    if (mainExport === undefined) return { listed: false };
    return { listed: true, target: packageTargetResolve(mainExport, null, conditions) ?? undefined };
  }
  // 3. A subpath, through the export paths.
  if (isRecord(exports) && hasExportPaths) {
    const match = packageImportsExportsResolve(subpath, exports, conditions);
    return match.matched ? { listed: true, target: match.resolved ?? undefined } : { listed: false };
  }
  // 4. Not exported.
  return { listed: false };
}
