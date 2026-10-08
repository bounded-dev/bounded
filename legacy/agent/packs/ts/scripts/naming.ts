// The naming derivations of TN-26-012 as pure functions, so every emitter and
// lint rule derives a name the same way. Each one is pinned against the
// worked example's real names in naming.test.ts. Inputs are the kebab-case
// names the contract paths carry (areas, features, file stems) and the
// PascalCase names the contracts declare (ports); every function refuses an
// input outside that grammar rather than guessing.

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;

function kebabWords(name: string): string[] {
  if (!KEBAB.test(name)) throw new Error(`'${name}' is not a kebab-case name`);
  return name.split("-");
}

const upperFirst = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** `create-note` → `CreateNote`; `project-management` → `ProjectManagement`. */
export function pascalCase(kebab: string): string {
  return kebabWords(kebab).map(upperFirst).join("");
}

/** `create-note` → `createNote`. */
export function camelCase(kebab: string): string {
  const [first, ...rest] = kebabWords(kebab);
  return first + rest.map(upperFirst).join("");
}

/** `project-management` → `project_management` (MCP tool names, SQL schema names). */
export function snakeCase(kebab: string): string {
  return kebabWords(kebab).join("_");
}

/** The words of a PascalCase name: `ProjectCsvExporter` → `["Project", "Csv", "Exporter"]`. */
export function pascalWords(name: string): string[] {
  if (!PASCAL.test(name)) throw new Error(`'${name}' is not a PascalCase name`);
  return name.match(/[A-Z][a-z0-9]*/g) ?? [name];
}

/** Does `singular` name one of `plural`? Only the three regular English plural
 *  forms count: `+s`, `+es`, and `y` → `ies`. Exact equality counts too, so a
 *  feature may repeat the area name verbatim (`list-notes` in `notes`). */
function namesArea(word: string, areaWord: string): boolean {
  return word === areaWord || `${word}s` === areaWord || `${word}es` === areaWord ||
    (word.endsWith("y") && `${word.slice(0, -1)}ies` === areaWord);
}

/**
 * The tRPC route key of a feature inside its area router (TN-26-012): the
 * feature's words with the FIRST occurrence of the area noun removed, then
 * camelCased. The area noun is the area's words, the last of which may appear
 * in singular form; it is searched from the second word on, because the first
 * is the verb. With no occurrence, the whole feature is the key.
 *
 *   notes/create-note → create        projects/list-projects → list
 *   notes/add-note-tag → addTag       order-lines/create-order-line → create
 *   notes/archive-all → archiveAll
 */
export function routeKey(area: string, feature: string): string {
  const areaWords = kebabWords(area);
  const words = kebabWords(feature);
  for (let i = 1; i + areaWords.length <= words.length; i++) {
    const head = areaWords.slice(0, -1).every((w, j) => words[i + j] === w);
    if (head && namesArea(words[i + areaWords.length - 1]!, areaWords.at(-1)!)) {
      const rest = [...words.slice(0, i), ...words.slice(i + areaWords.length)];
      return camelCase(rest.join("-"));
    }
  }
  return camelCase(feature);
}

/** One area of the grouped dependency shape (ADR LEG-2026-067). */
export interface DependencyGroup<T> {
  /** `camel(area)`: the router namespace, e.g. `taggingSchemes`. */
  readonly key: string;
  readonly area: string;
  /** Each feature under its route key, in the order given. */
  readonly members: readonly { readonly key: string; readonly item: T }[];
}

/**
 * The grouped dependency shape every in-adapter factory takes and every
 * composition root builds (ADR LEG-2026-067): `{ <camel(area)>: { <routeKey>:
 * <in port>, … }, … }`, the namespaces of the generated router
 * (`members.add`). Areas sorted, features in the order given. Two features
 * with one route key in an area are refused, naming both.
 */
export function dependencyGroups<T extends { readonly area: string; readonly feature: string }>(
  features: readonly T[],
): DependencyGroup<T>[] {
  const areas = [...new Set(features.map((f) => f.area))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return areas.map((area) => {
    const members: { key: string; item: T }[] = [];
    for (const item of features.filter((f) => f.area === area)) {
      const key = routeKey(area, item.feature);
      const other = members.find((m) => m.key === key);
      if (other !== undefined) {
        throw new Error(`features '${other.item.feature}' and '${item.feature}' share the route key '${camelCase(area)}.${key}'; rename one (TN-26-012 §6)`);
      }
      members.push({ key, item });
    }
    return { key: camelCase(area), area, members };
  });
}

/** The MCP tool name of a feature: `create-project` → `create_project`. */
export function toolName(feature: string): string {
  return snakeCase(feature);
}

/**
 * An out port's role: the last word of its name, lowercased. It is the file
 * role suffix of every adapter that implements the port and the name of the
 * handler's constructor parameter: `CreateNoteStore` → `store`,
 * `ProjectExporter` → `exporter`.
 */
export function portRole(portName: string): string {
  return pascalWords(portName).at(-1)!.toLowerCase();
}

/** An adapter technology's class prefix: `in-memory` → `InMemory`. */
export function adapterClassPrefix(technology: string): string {
  return pascalCase(technology);
}

/** The package export path of an adapter technology: `./adapters/<id>`. */
export function adapterExportPath(technology: string): string {
  kebabWords(technology);
  return `./adapters/${technology}`;
}

/** The context-relative barrel an adapter export path points at. */
export function adapterIndexPath(direction: "in" | "out", technology: string): string {
  kebabWords(technology);
  return `./src/adapters/${direction}/${technology}/index.ts`;
}

/** The verbs whose features are queries; every other verb is a command. */
export const QUERY_VERBS: readonly string[] = Object.freeze(["count", "find", "get", "list", "search"]);

/** CQRS kind by the feature's verb (its first word). */
export function featureKind(feature: string): "command" | "query" {
  return QUERY_VERBS.includes(kebabWords(feature)[0]!) ? "query" : "command";
}
