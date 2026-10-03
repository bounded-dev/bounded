// The generated composition root (ADR 2026-066, TN-26-012 §11).
//
// Every app pack (web, MCP, Lambda, desktop) emits its app's
// `composition-root.ts` through `compositionRoot` here, because what goes
// inside is the same everywhere and is this pack's knowledge: per feature the
// app exposes, `new <InPort>Handler(…)` with its out ports in declaration
// order, each backed by
//
//   · a store port: the store of the project's storage technology. A
//     technology that declares `connect` (a real database) wins; with none
//     composed, the technology whose database is a plain value constructed
//     with no arguments (the in-memory store). Two of either kind is refused.
//   · any other out port: the adapter of the first technology its
//     `@implementedBy` tag names (`ConsoleProjectExporter`).
//
// Infrastructure is created once per compose function: one database for the
// connected technology, read from its environment variable through a helper
// that refuses an unset value (never a fallback), with the driver the app's
// runtime selects (`connect.runtimes`); or one `new <Prefix>Database()` per
// context. The handlers are passed to the app's in-adapter factory in the
// grouped shape (`{ notes: { create, list } }`), the router's namespaces.
//
// The app pack supplies only what is its own: which features, which factory,
// the function names (`composeApp`, `compose<Entry>`) and its imports. No
// technology is named here: storage and drivers come from the adapter
// technologies in the facts. Pure: the same facts give the same bytes.

import type { AdapterTechnology, EmittedFile, ProjectFacts, WorkspaceFacts } from "../../ts/pack.ts";
import type { FeatureContractModel, OutPortModel } from "../../ts/scripts/feature-model.ts";
import { adapterClassPrefix, camelCase, dependencyGroups, pascalCase } from "../../ts/scripts/naming.ts";
import { fileText, WIDTH } from "./print.ts";

/** One `compose…()` function of a composition root. */
export interface ComposeFunction {
  /** `composeApp`, `composeExportProjects`. */
  readonly name: string;
  /** The return type annotation, e.g. `ProjectManagementRouter`. */
  readonly returns: string;
  /** The in-adapter factory it calls with the grouped handlers. */
  readonly factory: string;
  /** The features whose handlers it constructs, sorted by area, then feature. */
  readonly features: readonly FeatureContractModel[];
}

/** What an app pack knows about its composition root. */
export interface CompositionRootSpec {
  readonly app: WorkspaceFacts;
  /** Project-relative, e.g. `apps/web/src/server/composition-root.ts`. */
  readonly path: string;
  /** The in-adapter imports the functions use (factories, return types). */
  readonly imports: readonly { readonly from: string; readonly values?: readonly string[]; readonly types?: readonly string[] }[];
  readonly functions: readonly ComposeFunction[];
}

const HEADER = [
  "// Generated from the design (ADR 2026-066); do not edit: the design gate regenerates it.",
  "// The one place that decides which adapter backs which port.",
];

/** Import names per module, aliasing a name two modules export. */
class Imports {
  private readonly modules = new Map<string, { values: Map<string, string>; types: Set<string> }>();
  private readonly owners = new Map<string, string>();

  private module(from: string) {
    let entry = this.modules.get(from);
    if (entry === undefined) this.modules.set(from, (entry = { values: new Map(), types: new Set() }));
    return entry;
  }

  /** The local name for `name` from `from`; `alias` disambiguates a clash. */
  value(name: string, from: string, alias: () => string): string {
    const entry = this.module(from);
    const known = entry.values.get(name);
    if (known !== undefined) return known;
    const owner = this.owners.get(name);
    const local = owner === undefined || owner === from ? name : alias();
    if (local !== name && this.owners.has(local)) throw new Error(`two imports would both be named ${local}`);
    this.owners.set(local, from);
    entry.values.set(name, local);
    return local;
  }

  type(name: string, from: string): void {
    const owner = this.owners.get(name);
    if (owner !== undefined && owner !== from) throw new Error(`two imports would both be named ${name}`);
    this.owners.set(name, from);
    this.module(from).types.add(name);
  }

  lines(): string[] {
    const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    return [...this.modules].sort(([a], [b]) => byCodePoint(a, b)).map(([from, { values, types }]) => {
      const valueNames = [...values].map(([name, local]) => (name === local ? name : `${name} as ${local}`)).sort(byCodePoint);
      const typeOnly = valueNames.length === 0;
      const names = [...valueNames, ...[...types].sort(byCodePoint).map((t) => (typeOnly ? t : `type ${t}`))];
      const head = typeOnly ? "import type" : "import";
      const line = `${head} { ${names.join(", ")} } from "${from}";`;
      return line.length <= WIDTH ? line : `${head} {\n${names.map((n) => `  ${n},`).join("\n")}\n} from "${from}";`;
    });
  }
}

/** The storage technology whose stores a composition root constructs. */
export function compositionStorage(facts: ProjectFacts): AdapterTechnology {
  const storage = facts.adapterTechnologies.filter((t) => t.direction === "out" && t.storage);
  const connected = storage.filter((t) => t.connect !== undefined);
  const chosen = connected.length > 0 ? connected : storage.filter((t) => t.database === "value");
  if (chosen.length !== 1) {
    throw new Error(chosen.length === 0
      ? "a feature has a store port, but no composed storage technology can be constructed by a composition root"
      : `${chosen.length} composed storage technologies could back the stores (${chosen.map((t) => t.id).join(", ")}); ` +
        "compose one, so every composition root constructs the same one");
  }
  return chosen[0]!;
}

/** `DATABASE_URL` → `databaseUrl`. */
const envFunction = (env: string): string => camelCase(env.toLowerCase().split("_").filter((w) => w !== "").join("-"));

function packageOf(facts: ProjectFacts, context: string): string {
  return facts.workspaces.find((w) => w.dir === `contexts/${context}`)?.packageName ?? `${facts.scope}/${context}`;
}

/** The emitted composition root of one app. */
export function compositionRoot(facts: ProjectFacts, spec: CompositionRootSpec): EmittedFile {
  const imports = new Imports();
  for (const entry of spec.imports) {
    for (const value of entry.values ?? []) imports.value(value, entry.from, () => value);
    for (const type of entry.types ?? []) imports.type(type, entry.from);
  }
  const runtime = facts.workspaceTemplates.find((t) => t.kind === spec.app.kind)?.runtime;
  const helpers = new Map<string, string[]>();
  const fromContext = (context: string, layer: string, name: string): string =>
    imports.value(name, `${packageOf(facts, context)}/${layer}`, () => `${pascalCase(context)}${name}`);

  const functions = spec.functions.map((fn) => {
    const needsStore = fn.features.some((f) => f.outPorts.some((p) => p.isStore));
    const storage = needsStore ? compositionStorage(facts) : undefined;
    const contexts = [...new Set(fn.features.filter((f) => f.outPorts.some((p) => p.isStore)).map((f) => f.context))].sort();
    const infrastructure: string[] = [];
    const databases = new Map<string, string>();
    if (storage?.connect !== undefined) {
      const driver = runtime === undefined ? undefined : storage.connect.runtimes[runtime];
      if (driver === undefined) {
        throw new Error(`${spec.app.dir} (${spec.app.kind}) runs on '${runtime ?? "no runtime"}', for which the storage technology ` +
          `'${storage.id}' declares no connect driver`);
      }
      const connect = imports.value(driver.function, driver.from, () => `${camelCase(storage.id)}${pascalCase(driver.function)}`);
      const url = envFunction(storage.connect.env);
      helpers.set(url, [
        `// ${storage.connect.env} comes only from the environment: never a hard-coded address, never a fallback.`,
        `function ${url}(): string {`,
        `  const value = process.env.${storage.connect.env};`,
        `  if (value === undefined || value === "") throw new Error(${JSON.stringify(`${storage.connect.env} is not set`)});`,
        "  return value;",
        "}",
      ]);
      infrastructure.push(`const db = ${connect}(${url}());`);
      for (const context of contexts) databases.set(context, "db");
    } else if (storage !== undefined) {
      for (const context of contexts) {
        const variable = contexts.length === 1 ? "db" : `${camelCase(context)}Db`;
        const database = fromContext(context, `adapters/${storage.id}`, `${adapterClassPrefix(storage.id)}Database`);
        infrastructure.push(`const ${variable} = new ${database}();`);
        databases.set(context, variable);
      }
    }

    const adapter = (feature: FeatureContractModel, port: OutPortModel): string => {
      if (port.isStore) {
        const store = fromContext(feature.context, `adapters/${storage!.id}`, `${adapterClassPrefix(storage!.id)}${port.name}`);
        return `new ${store}(${databases.get(feature.context)!})`;
      }
      const id = port.implementedBy[0];
      const technology = facts.adapterTechnologies.find((t) => t.id === id && t.direction === "out" && !t.storage);
      if (id === undefined || technology === undefined) {
        throw new Error(`${feature.contractPath}: ${port.name} has no composed @implementedBy technology for the composition root to construct`);
      }
      return `new ${fromContext(feature.context, `adapters/${id}`, `${adapterClassPrefix(id)}${port.name}`)}()`;
    };

    const member = (key: string, feature: FeatureContractModel): string[] => {
      const handler = fromContext(feature.context, "application", `${feature.inPort.name}Handler`);
      const args = feature.outPorts.map((port) => adapter(feature, port));
      const line = `      ${key}: new ${handler}(${args.join(", ")}),`;
      if (line.length <= WIDTH || args.length === 0) return [line];
      return [`      ${key}: new ${handler}(`, ...args.map((a) => `        ${a},`), "      ),"];
    };

    const groups = dependencyGroups(fn.features);
    return [
      `export function ${fn.name}(): ${fn.returns} {`,
      ...infrastructure.map((line) => `  ${line}`),
      ...(infrastructure.length === 0 ? [] : [""]),
      `  return ${fn.factory}({`,
      ...groups.flatMap((g) => [`    ${g.key}: {`, ...g.members.flatMap((m) => member(m.key, m.item)), "    },"]),
      "  });",
      "}",
    ];
  });

  const blocks = [...functions, ...[...helpers.values()]];
  return {
    path: spec.path,
    mode: "generated",
    content: fileText([...HEADER, ...imports.lines(), ...blocks.flatMap((block) => ["", ...block])]),
  };
}
