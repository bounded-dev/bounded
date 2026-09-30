// The path and name grammar of the hexagonal layout (TN-26-012 §1, §2), as
// pure functions shared by the feature parser, the emitters and the lint
// rules, so each of them classifies a path and judges a name the same way.
//
// Every function here refuses rather than guesses: a name outside the grammar
// is `false` / `undefined`, never "probably fine".

export const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const PASCAL = /^[A-Z][A-Za-z0-9]*$/;

/** Plurals that do not end in `s`. Kept short on purpose: a new entry is a
 *  vocabulary decision, and an area name outside it is refused rather than
 *  guessed (TN-26-012 §2). */
export const IRREGULAR_PLURALS: ReadonlySet<string> = new Set([
  "children", "criteria", "data", "feet", "geese", "media", "men", "mice", "people", "phenomena", "teeth", "women",
]);

/** An area folder: kebab-case whose last word is plural (`notes`, `order-lines`, `people`). */
export function isAreaName(area: string): boolean {
  if (!KEBAB.test(area)) return false;
  const last = area.split("-").at(-1)!;
  return IRREGULAR_PLURALS.has(last) || (last.length > 1 && last.endsWith("s") && !last.endsWith("ss"));
}

/** The singular forms an area's last word may take inside a feature name:
 *  `notes` → `note`, `boxes` → `box`, `categories` → `category`. */
function singularsOf(word: string): string[] {
  const out = new Set<string>([word]);
  if (word.endsWith("ies")) out.add(`${word.slice(0, -3)}y`);
  if (word.endsWith("es")) out.add(word.slice(0, -2));
  if (word.endsWith("s")) out.add(word.slice(0, -1));
  return [...out];
}

/**
 * A feature folder: kebab-case, at least two words, verb first. "Verb first"
 * is checked from the only side a machine can check: the first word may not
 * be the area's own noun (`note-create` in `notes` is noun-first).
 */
export function featureNameProblem(area: string, feature: string): string | undefined {
  if (!KEBAB.test(feature)) return `'${feature}' is not kebab-case`;
  const words = feature.split("-");
  if (words.length < 2) return `'${feature}' must have at least two words, verb first (e.g. 'create-note', 'list-notes')`;
  if (KEBAB.test(area)) {
    const areaWords = area.split("-");
    if (areaWords.length === 1 && singularsOf(areaWords[0]!).includes(words[0]!)) {
      return `'${feature}' starts with the area noun; a feature name is verb first (e.g. 'create-${words[0]}')`;
    }
    if (areaWords.length > 1 && words.slice(0, areaWords.length).join("-") === areaWords.join("-")) {
      return `'${feature}' starts with the area name; a feature name is verb first`;
    }
  }
  return undefined;
}

/** Test-side file names (TN-26-012 §8). Matching ignores case. */
export const TEST_SUFFIXES: readonly string[] = Object.freeze([".test.ts", ".test.tsx", ".test-support.ts"]);

export function isTestSide(path: string): boolean {
  const lower = path.toLowerCase();
  return TEST_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** Where a project-relative path sits in the hexagonal layout. */
export type HexLocation =
  | {
      readonly workspace: "context";
      readonly name: string;
      /** `contexts/<name>` */
      readonly dir: string;
      /** Segments below `src/`. */
      readonly inner: readonly string[];
      readonly layer: "domain" | "application" | "adapters-in" | "adapters-out" | "none";
      /** Adapter technology folder, for adapter layers. */
      readonly tech?: string;
    }
  | {
      readonly workspace: "app";
      readonly name: string;
      /** `apps/<name>` */
      readonly dir: string;
      readonly inner: readonly string[];
      /** `client/` or `renderer/`: code that runs in a browser. */
      readonly browser: boolean;
    };

const WORKSPACE_ROOTS: Readonly<Record<string, "context" | "app">> = { contexts: "context", apps: "app" };

/**
 * Classify a project-relative, `/`-separated path. Undefined when it is not
 * strictly inside a source root (`contexts/*\/src`, `apps/*\/src`).
 */
export function locate(path: string): HexLocation | undefined {
  const segments = path.split("/");
  const kind = WORKSPACE_ROOTS[segments[0] ?? ""];
  if (kind === undefined || segments.length < 4 || segments[2] !== "src" || segments[1] === "") return undefined;
  const name = segments[1]!;
  const inner = segments.slice(3);
  const dir = `${segments[0]}/${name}`;
  if (kind === "app") {
    return { workspace: "app", name, dir, inner, browser: inner.length > 1 && (inner[0] === "client" || inner[0] === "renderer") };
  }
  const [top, second, third] = inner;
  if (inner.length > 1 && top === "domain") return { workspace: "context", name, dir, inner, layer: "domain" };
  if (inner.length > 1 && top === "application") return { workspace: "context", name, dir, inner, layer: "application" };
  if (inner.length > 3 && top === "adapters" && (second === "in" || second === "out")) {
    return { workspace: "context", name, dir, inner, layer: second === "in" ? "adapters-in" : "adapters-out", tech: third! };
  }
  return { workspace: "context", name, dir, inner, layer: "none" };
}

/** The POSIX-normalised join of a project-relative directory and a relative
 *  specifier; undefined when it climbs above the project root. */
export function joinRelative(fromDir: string, specifier: string): string | undefined {
  const out = fromDir === "" ? [] : fromDir.split("/");
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.join("/");
}

/** `@scope/name/sub/path` → { name: "@scope/name", subpath: "sub/path" }; bare
 *  `pkg/x` → { name: "pkg", subpath: "x" }. Undefined for relative, absolute
 *  or protocol specifiers. */
export function packageOf(specifier: string): { name: string; subpath: string } | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":") || specifier === "") return undefined;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2 || parts[1] === "") return undefined;
    return { name: `${parts[0]}/${parts[1]}`, subpath: parts.slice(2).join("/") };
  }
  return { name: parts[0]!, subpath: parts.slice(1).join("/") };
}
