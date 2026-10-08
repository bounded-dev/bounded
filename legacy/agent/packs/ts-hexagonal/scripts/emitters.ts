// The ts-hexagonal pack's skeleton emitters (ADR 2026-060, TN-26-012 §5-§7).
//
// Each is a pure function of the project's facts: no clock, no environment,
// stable ordering, and one fixed layout (print.ts). `generated` files match
// the worked example byte for byte; `skeleton` files match its declarations
// (class, constructor, method signatures) and differ only in their bodies,
// which throw `NotImplementedError` until the builder writes them.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterTechnology, EmittedFile, Emitter, ProjectFacts } from "../../ts/pack.ts";
import type { FeatureContractModel, OutPortModel, TypeRef } from "../../ts/scripts/feature-model.ts";
import { adapterClassPrefix } from "../../ts/scripts/naming.ts";
import { type ContextModel, contextModels } from "./context-model.ts";
import { braced, fileText, parameterProperties, referencedNames, signature, upTo, WIDTH } from "./print.ts";

const generated = (path: string, lines: readonly string[]): EmittedFile => ({ path, content: fileText(lines), mode: "generated" });
const skeleton = (path: string, lines: readonly string[]): EmittedFile => ({ path, content: fileText(lines), mode: "skeleton" });

const featureDir = (model: ContextModel, f: FeatureContractModel): string =>
  `${model.root}/application/${f.area}/${f.feature}`;
const applicationImport = (model: ContextModel): string => `${model.packageName}/application`;
const domainImport = (model: ContextModel): string => `${model.packageName}/domain`;

/** Blocks separated by one blank line. */
const joinBlocks = (blocks: readonly (readonly string[])[]): string[] =>
  blocks.flatMap((block, i) => (i === 0 ? [...block] : ["", ...block]));

// --- domain ---------------------------------------------------------------------

export const RESULT_SOURCE = "export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };\n";

export const ERRORS_SOURCE = [
  "// Generated for the red phase; delivery removes it.",
  "export class NotImplementedError extends Error {",
  "  constructor(member: string) {",
  "    super(`Not implemented: ${member}`);",
  '    this.name = "NotImplementedError";',
  "  }",
  "}",
  "",
].join("\n");

export const domainResultEmitter: Emitter = {
  name: "hexagonal-domain-result",
  description: "contexts/<context>/src/domain/shared/result.ts: the one Result type every layer returns",
  emit: (facts) => contextModels(facts).map((m) => ({
    path: `${m.root}/domain/shared/result.ts`, content: RESULT_SOURCE, mode: "generated" as const,
  })),
};

export const domainErrorsEmitter: Emitter = {
  name: "hexagonal-domain-errors",
  description: "contexts/<context>/src/domain/shared/errors.ts: NotImplementedError for skeleton bodies, at design and red only",
  emit: (facts) => facts.phase === "deliver" ? [] : contextModels(facts).map((m) => ({
    path: `${m.root}/domain/shared/errors.ts`, content: ERRORS_SOURCE, mode: "generated" as const,
  })),
};

export const domainBarrelEmitter: Emitter = {
  name: "hexagonal-domain-barrel",
  description: "contexts/<context>/src/domain/index.ts: Result, every factory as a type, every concept from its implementation",
  emit: (facts) => contextModels(facts).map((m) => {
    const areas = [...new Set(m.concepts.map((c) => c.area))];
    const blocks = areas.map((area) => {
      const concepts = m.concepts.filter((c) => c.area === area);
      return [
        ...concepts.map((c) => braced("export type", [`${c.name}Factory`], `from "./${area}/${c.stem}.contract.ts";`)),
        ...concepts.map((c) => braced("export", [c.name], `from "./${area}/${c.stem}.ts";`)),
      ];
    });
    if (blocks.length > 0) blocks[0]!.unshift("// Each export is both the contract type and its implementation value.");
    return generated(`${m.root}/domain/index.ts`, joinBlocks([['export type { Result } from "./shared/result.ts";'], ...blocks]));
  }),
};

// --- application ------------------------------------------------------------------

export const applicationBarrelEmitter: Emitter = {
  name: "hexagonal-application-barrel",
  description: "contexts/<context>/src/application/index.ts: contracts as types, commands, schemas and handlers",
  emit: (facts) => contextModels(facts).map((m) => {
    const blocks = m.features.map((f) => {
      const base = `./${f.area}/${f.feature}/${f.feature}`;
      const types = [f.inPort.name, ...f.outPorts.map((p) => p.name)];
      if (f.input !== undefined) types.push(f.input.commandFactoryName, f.input.inputName);
      const lines = [braced("export type", types.sort(), `from "${base}.contract.ts";`)];
      if (f.input !== undefined) lines.push(braced("export", [f.input.commandName, f.input.schemaName], `from "${base}.command.ts";`));
      lines.push(braced("export", [`${f.inPort.name}Handler`], `from "${base}.handler.ts";`));
      return lines;
    });
    if (m.shared.length > 0) {
      blocks.unshift(m.shared.map((c) => braced("export type", c.names, `from "./shared/${c.stem}.contract.ts";`)));
    }
    const header = "// Contracts are exported as types. Commands are exported from their implementation file (type and value together).";
    return generated(`${m.root}/application/index.ts`, [header, ...(blocks.length === 0 ? ["export {};"] : joinBlocks(blocks))]);
  }),
};

function commandSource(m: ContextModel, f: FeatureContractModel): string[] {
  const input = f.input!;
  const impl = `${input.commandName}Impl`;
  const concepts = [...new Set(input.fields.map((field) => field.concept))].sort();
  const fields = input.fields;
  const last = fields.at(-1)!;
  const construct = `new ${impl}(${fields.map((field) => `${field.name}.value`).join(", ")})`;
  const tail = `    return ${last.name}.ok ? { ok: true, value: ${construct} } : ${last.name};`;
  const returnLines = tail.length <= WIDTH ? [tail] : [
    `    return ${last.name}.ok`,
    `      ? { ok: true, value: ${construct} }`,
    `      : ${last.name};`,
  ];
  return [
    'import { z } from "zod";',
    braced("import", [...concepts, "type Result"], `from "${domainImport(m)}";`),
    `import type * as Contract from "./${f.feature}.contract.ts";`,
    "",
    "// Wire contract: tRPC and MCP use this for their input types.",
    `export const ${input.schemaName} = z.object({`,
    ...fields.map((field) => `  ${field.name}: z.${field.wireType}(),`),
    `}) satisfies z.ZodType<Contract.${input.inputName}>;`,
    "",
    `class ${impl} implements Contract.${input.commandName} {`,
    `  declare readonly __brand: "${input.commandName}";`,
    ...parameterProperties("private constructor", fields.map((field) => `readonly ${field.name}: ${field.concept}`), "  "),
    "",
    `  static parse(raw: unknown): Result<${input.commandName}> {`,
    `    const input = ${input.schemaName}.safeParse(raw);`,
    `    if (!input.success) return { ok: false, error: "Invalid ${f.feature.split("-").join(" ")} input" };`,
    ...fields.slice(0, -1).flatMap((field) => [
      `    const ${field.name} = ${field.concept}.parse(input.data.${field.name});`,
      `    if (!${field.name}.ok) return ${field.name};`,
    ]),
    `    const ${last.name} = ${last.concept}.parse(input.data.${last.name});`,
    ...returnLines,
    "  }",
    "}",
    "",
    `export type ${input.commandName} = Contract.${input.commandName};`,
    `export const ${input.commandName}: Contract.${input.commandFactoryName} = ${impl};`,
  ];
}

export const commandEmitter: Emitter = {
  name: "hexagonal-command",
  description: "<feature>.command.ts for every feature with Input: the zod wire schema and the Command implementation",
  emit: (facts) => contextModels(facts).flatMap((m) => m.features.filter((f) => f.input !== undefined).map((f) =>
    generated(`${featureDir(m, f)}/${f.feature}.command.ts`, commandSource(m, f)))),
};

const SAMPLES: Readonly<Record<"string" | "number" | "boolean", { list: string; values: string; wrong: string }>> = {
  string: {
    list: "STRINGS",
    values: '["", " ", "a", "Hello, world", "not-a-uuid", "00000000-0000-4000-8000-000000000000", "x".repeat(300)]',
    wrong: "42",
  },
  number: { list: "NUMBERS", values: "[0, 1, -1, 42, 3.5, 1e9, -0.25]", wrong: '"42"' },
  boolean: { list: "BOOLEANS", values: "[true, false]", wrong: '"true"' },
};

function commandLawsSource(m: ContextModel, f: FeatureContractModel): string[] {
  const input = f.input!;
  const command = input.commandName;
  const fields = input.fields;
  const concepts = [...new Set(fields.map((field) => field.concept))].sort();
  const wireTypes = (["string", "number", "boolean"] as const).filter((w) => fields.some((field) => field.wireType === w));
  const size = Math.max(...wireTypes.map((w) => (w === "boolean" ? 2 : 7)));
  const wire = fields.map((field, k) => {
    const { list } = SAMPLES[field.wireType];
    const index = k === 0 ? "i" : k === 1 ? "i + j" : `i + j * ${k}`;
    return `    ${field.name}: ${list}[${k === 0 ? index : `(${index})`} % ${list}.length],`;
  });
  const checks = fields.flatMap((field) => [
    `      const ${field.name} = ${field.concept}.parse(raw.${field.name});`,
    `      if (!${field.name}.ok) {`,
    `        expect(result).toEqual(${field.name});`,
    "        continue;",
    "      }",
  ]);
  return [
    `// Generated from ${f.feature}.contract.ts by the ts-hexagonal pack; do not edit.`,
    `// The laws every ${command} obeys, whatever its value objects accept.`,
    'import { describe, expect, test } from "bun:test";',
    braced("import", concepts, `from "${domainImport(m)}";`),
    braced("import", [command], `from "./${f.feature}.command.ts";`),
    "",
    `const INVALID = { ok: false as const, error: "Invalid ${f.feature.split("-").join(" ")} input" };`,
    ...wireTypes.map((w) => `const ${SAMPLES[w].list} = ${SAMPLES[w].values};`),
    "",
    "function wire(i: number, j: number): Record<string, unknown> {",
    "  return {",
    ...wire,
    "  };",
    "}",
    "",
    `const cases = Array.from({ length: ${size * size} }, (_, n) => wire(Math.floor(n / ${size}), n % ${size}));`,
    "",
    `describe("${command} laws", () => {`,
    '  test("refuses anything that is not an object", () => {',
    "    for (const raw of [undefined, null, 0, 1, \"\", \"text\", true, [], [wire(0, 0)]]) {",
    `      expect(${command}.parse(raw)).toEqual(INVALID);`,
    "    }",
    "  });",
    "",
    '  test("refuses input missing any field", () => {',
    `    for (const field of [${fields.map((field) => `"${field.name}"`).join(", ")}]) {`,
    "      const raw = wire(0, 0);",
    "      delete raw[field];",
    `      expect(${command}.parse(raw)).toEqual(INVALID);`,
    "    }",
    "  });",
    "",
    '  test("refuses a field of the wrong wire type", () => {',
    ...fields.map((field) =>
      `    expect(${command}.parse({ ...wire(0, 0), ${field.name}: ${SAMPLES[field.wireType].wrong} })).toEqual(INVALID);`),
    "  });",
    "",
    '  test("validates each field through its value object, in declaration order", () => {',
    "    for (const raw of cases) {",
    `      const result = ${command}.parse(raw);`,
    ...checks,
    "      if (!result.ok) throw new Error(`expected ${JSON.stringify(raw)} to parse`);",
    ...fields.map((field) => `      expect(result.value.${field.name}.equals(${field.name}.value)).toBe(true);`),
    "    }",
    "  });",
    "",
    '  test("ignores fields the input does not declare", () => {',
    "    for (const raw of cases) {",
    `      const plain = JSON.stringify(${command}.parse(raw));`,
    `      expect(JSON.stringify(${command}.parse({ ...raw, undeclared: "x" }))).toBe(plain);`,
    "    }",
    "  });",
    "});",
  ];
}

export const commandLawsEmitter: Emitter = {
  name: "hexagonal-command-laws",
  description: "<feature>.command.laws.test.ts for every feature with Input: wire refusal and field-by-field value-object laws",
  emit: (facts) => contextModels(facts).flatMap((m) => m.features.filter((f) => f.input !== undefined).map((f) =>
    generated(`${featureDir(m, f)}/${f.feature}.command.laws.test.ts`, commandLawsSource(m, f)))),
};

function handlerSource(m: ContextModel, f: FeatureContractModel, path: string): string[] {
  const handler = `${f.inPort.name}Handler`;
  const params = f.inPort.parameter === undefined ? [] : [f.inPort.parameter];
  const returns: TypeRef = { kind: "other", text: f.inPort.returns.text };
  const names = referencedNames(f, [...params.map((p) => p.type), returns]);
  const fromContract = [...new Set([f.inPort.name, ...names.local, ...f.outPorts.map((p) => p.name)])].sort();
  return [
    ...(names.domain.length === 0 ? [] : [braced("import type", names.domain, `from "${domainImport(m)}";`)]),
    `import { NotImplementedError } from "${upTo(m.root, path)}domain/shared/errors.ts";`,
    braced("import type", fromContract, `from "./${f.feature}.contract.ts";`),
    "",
    `export class ${handler} implements ${f.inPort.name} {`,
    ...parameterProperties("constructor", f.outPorts.map((p) => `private readonly ${p.role}: ${p.name}`), "  "),
    ...(f.outPorts.length === 0 ? [] : [""]),
    `  async execute${signature(params, returns)} {`,
    `    throw new NotImplementedError("${handler}.execute");`,
    "  }",
    "}",
  ];
}

export const handlerEmitter: Emitter = {
  name: "hexagonal-handler",
  description: "<feature>.handler.ts skeletons: the out ports in declaration order, execute throwing NotImplementedError",
  emit: (facts) => contextModels(facts).flatMap((m) => m.features.map((f) => {
    const path = `${featureDir(m, f)}/${f.feature}.handler.ts`;
    return skeleton(path, handlerSource(m, f, path));
  })),
};

// --- out adapters ---------------------------------------------------------------------

const outTechnologies = (facts: ProjectFacts): AdapterTechnology[] =>
  facts.adapterTechnologies.filter((t) => t.direction === "out");

interface Implementation {
  readonly feature: FeatureContractModel;
  readonly port: OutPortModel;
  readonly className: string;
  /** Adapter-folder-relative, e.g. `notes/create-note.store.ts`. */
  readonly file: string;
}

/** The out ports a technology implements in one context, area then feature. */
function implementations(m: ContextModel, technology: AdapterTechnology): Implementation[] {
  const prefix = adapterClassPrefix(technology.id);
  return m.features.flatMap((feature) => feature.outPorts
    .filter((port) => (technology.storage ? port.isStore : port.implementedBy.includes(technology.id)))
    .map((port) => ({
      feature, port,
      className: `${prefix}${port.name}`,
      file: `${feature.area}/${feature.feature}.${port.role}.ts`,
    })));
}

function adapterSource(m: ContextModel, technology: AdapterTechnology, item: Implementation, path: string): string[] {
  const { feature, port, className } = item;
  const names = referencedNames(feature, port.methods.flatMap((method) => [...method.parameters.map((p) => p.type), method.returns]), m.sharedNames);
  const database = `${adapterClassPrefix(technology.id)}Database`;
  const methods = port.methods.map((method) => [
    `  async ${method.name}${signature(method.parameters, method.returns)} {`,
    `    throw new NotImplementedError("${className}.${method.name}");`,
    "  }",
  ]);
  return [
    braced("import type", [...new Set([port.name, ...names.local])].sort(), `from "${applicationImport(m)}";`),
    ...(names.domain.length === 0 ? [] : [braced("import type", names.domain, `from "${domainImport(m)}";`)]),
    `import { NotImplementedError } from "${upTo(m.root, path)}domain/shared/errors.ts";`,
    ...(technology.storage ? [`import type { ${database} } from "../${technology.id}-database.ts";`] : []),
    "",
    `export class ${className} implements ${port.name} {`,
    ...(technology.storage ? [`  constructor(private readonly db: ${database}) {}`, ""] : []),
    ...joinBlocks(methods),
    "}",
  ];
}

export const IN_MEMORY = "in-memory";

export const inMemoryEmitter: Emitter = {
  name: "hexagonal-in-memory",
  description: "adapters/out/in-memory: the InMemoryDatabase skeleton and one store skeleton per <Feature>Store port",
  emit: (facts) => {
    const technology = outTechnologies(facts).find((t) => t.id === IN_MEMORY && t.storage);
    if (technology === undefined) return [];
    return contextModels(facts).flatMap((m) => {
      const items = implementations(m, technology);
      if (items.length === 0) return [];
      const dir = `${m.root}/adapters/out/${IN_MEMORY}`;
      return [
        skeleton(`${dir}/${IN_MEMORY}-database.ts`, ["export class InMemoryDatabase {}"]),
        ...items.map((item) => skeleton(`${dir}/${item.file}`, adapterSource(m, technology, item, `${dir}/${item.file}`))),
      ];
    });
  },
};

export const outAdapterEmitter: Emitter = {
  name: "hexagonal-out-adapters",
  description: "adapters/out/<tech>/<area>/<feature>.<role>.ts skeletons for every @implementedBy technology of a non-store out port",
  emit: (facts) => {
    const technologies = outTechnologies(facts).filter((t) => !t.storage);
    return contextModels(facts).flatMap((m) => technologies.flatMap((technology) => implementations(m, technology).map((item) => {
      const path = `${m.root}/adapters/out/${technology.id}/${item.file}`;
      return skeleton(path, adapterSource(m, technology, item, path));
    })));
  },
};

export const outBarrelEmitter: Emitter = {
  name: "hexagonal-out-barrels",
  description: "adapters/out/<tech>/index.ts for every out technology a context uses: its database, then each adapter class",
  emit: (facts) => contextModels(facts).flatMap((m) => outTechnologies(facts).flatMap((technology) => {
    const items = implementations(m, technology);
    if (items.length === 0) return [];
    const lines = items.map((item) => braced("export", [item.className], `from "./${item.file}";`));
    if (technology.storage) {
      // A class re-exports as a value; a type alias only as a type, or the
      // barrel fails at runtime with "export not found".
      if (technology.database !== "value" && technology.database !== "type") {
        throw new Error(`storage technology '${technology.id}' does not say whether its database is a value or a type`);
      }
      const head = technology.database === "type" ? "export type" : "export";
      lines.unshift(braced(head, [`${adapterClassPrefix(technology.id)}Database`], `from "./${technology.id}-database.ts";`));
    }
    return [generated(`${m.root}/adapters/out/${technology.id}/index.ts`, lines)];
  })),
};

// --- workspaces ---------------------------------------------------------------------------

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** Fill a template's `{{scope}}`, `{{name}}` and `{{package}}`; any other
 *  placeholder is refused (TN-26-012 §10). */
export function renderTemplate(text: string, values: { scope: string; name: string; package: string }, where: string): string {
  return text.replace(PLACEHOLDER, (_, key: string) => {
    if (key === "scope" || key === "name" || key === "package") return values[key];
    throw new Error(`${where} uses the placeholder '{{${key}}}'; only {{scope}}, {{name}} and {{package}} exist`);
  });
}

const defaultPacksDir = (): string => join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The seed files of every workspace's template, rendered. Reads only the
 *  composed packs' own template files. */
export function workspaceSeedEmitter(packsDir = defaultPacksDir()): Emitter {
  return {
    name: "hexagonal-workspace-seeds",
    description: "each workspace's template files (entry files and other seeds), with its scope and name filled in",
    emit: (facts) => facts.workspaces.flatMap((workspace) => {
      const template = facts.workspaceTemplates.find((t) => t.kind === workspace.kind);
      if (template === undefined) throw new Error(`workspace '${workspace.dir}' is of kind '${workspace.kind}', which no composed pack templates`);
      return template.files.map((file) => {
        const where = `${template.pack} template '${template.kind}' file '${file.path}'`;
        const text = renderTemplate(readFileSync(join(packsDir, template.pack, file.source), "utf8"), {
          scope: facts.scope, name: workspace.name, package: workspace.packageName,
        }, where);
        return { path: `${workspace.dir}/${file.path}`, content: text.endsWith("\n") ? text : `${text}\n`, mode: file.mode };
      });
    }),
  };
}

/** Every emitter this pack contributes, in a fixed order. */
export const TS_HEXAGONAL_EMITTERS: readonly Emitter[] = Object.freeze([
  domainResultEmitter,
  domainErrorsEmitter,
  domainBarrelEmitter,
  applicationBarrelEmitter,
  commandEmitter,
  commandLawsEmitter,
  handlerEmitter,
  inMemoryEmitter,
  outAdapterEmitter,
  outBarrelEmitter,
  workspaceSeedEmitter(),
]);
