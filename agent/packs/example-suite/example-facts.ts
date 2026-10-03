// Test support shared by the in-adapter and app packs' suites, kept outside
// every pack so no pack's tests reach across an undeclared edge and no
// shipped pack code imports it: the worked
// example (reference/example, a copy of its project-management context and its
// four apps, with the TN-26-012 §4 tags added to the feature contracts, and
// with its dependencies grouped by area in the routers, the MCP server, the
// Lambda factory and the generated composition roots: the deliberate
// departure of ADR 2026-066) as the `ProjectFacts` a gate would hand the
// emitters. reference/net-worth holds the 2026-10-03 dogfood's contracts and
// golden composition roots (composition-roots.test.ts).
//
// The copy is inline in the harness on purpose: a test never reads a path
// outside the repository. When ts-hexagonal's reference context lands (WI-5),
// this file can point at it and the copy here can go.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { adapterTechnologies, workspaceTemplates, type ContractSource, type ProjectFacts, type WorkspaceFacts } from "../ts/pack.ts";

export const EXAMPLE_ROOT = join(import.meta.dirname, "reference", "example");
export const EXAMPLE_CONTEXT = "contexts/project-management";

/** Every file under a directory of the example, as project-relative paths, sorted. */
export function exampleFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const name of readdirSync(abs).sort()) {
      const path = join(abs, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(EXAMPLE_ROOT, path).split("\\").join("/"));
    }
  };
  walk(join(EXAMPLE_ROOT, dir));
  return out.sort();
}

export const readExample = (path: string): string => readFileSync(join(EXAMPLE_ROOT, path), "utf8");

/** The example's contracts, exactly as a gate would collect them. */
export function exampleContracts(): ContractSource[] {
  return exampleFiles(`${EXAMPLE_CONTEXT}/src`).filter((p) => p.endsWith(".contract.ts"))
    .map((path) => ({ path, source: readExample(path) }));
}

/** Everything the in-adapter and app packs need, composed. */
export const EXAMPLE_PACKS = ["ts", "ts-hexagonal", "ts-trpc", "ts-mcp", "ts-lambda", "ts-web", "ts-desktop"] as const;

const APPS: readonly (readonly [string, string])[] = [
  ["apps/desktop", "desktop"],
  ["apps/lambdas", "lambdas"],
  ["apps/mcp", "mcp"],
  ["apps/web", "web"],
];

export function exampleFacts(overrides: { contracts?: ContractSource[]; packs?: readonly string[] } = {}): ProjectFacts {
  const packs = overrides.packs ?? EXAMPLE_PACKS;
  const context: WorkspaceFacts = {
    dir: EXAMPLE_CONTEXT, name: "project-management", kind: "context", packageName: "@example/project-management",
    sourceRoot: `${EXAMPLE_CONTEXT}/src`, contracts: overrides.contracts ?? exampleContracts(),
  };
  const apps = APPS.map(([dir, kind]): WorkspaceFacts => {
    const name = dir.split("/")[1]!;
    return { dir, name, kind, packageName: `@example/${name}`, sourceRoot: `${dir}/src`, contracts: [] };
  });
  return {
    scope: "@example",
    phase: "design",
    packs,
    workspaces: [...apps, context].sort((a, b) => (a.dir < b.dir ? -1 : 1)),
    adapterTechnologies: adapterTechnologies(packs),
    workspaceTemplates: workspaceTemplates(packs),
  };
}

interface Manifest {
  readonly [field: string]: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

/**
 * A workspace template manifest against the example app's `package.json`,
 * the way TN-26-012 §10 and ADR 2026-061 relate them: the generator adds
 * `name` and `private`, and the `workspace:*` dependencies from the
 * composition root's imports; the template pins exactly where the example
 * writes a range. Returns the differences, one line each.
 */
export function manifestDifferences(template: Manifest, example: Manifest): string[] {
  const out: string[] = [];
  const { name: _name, private: _private, dependencies: exDeps, devDependencies: exDev, ...exRest } = example;
  const { dependencies: tDeps, devDependencies: tDev, ...tRest } = template;
  if (JSON.stringify(tRest) !== JSON.stringify(exRest)) out.push(`fields: template ${JSON.stringify(tRest)} vs example ${JSON.stringify(exRest)}`);
  for (const [section, ex, pinned] of [["dependencies", exDeps, tDeps], ["devDependencies", exDev, tDev]] as const) {
    const expected = Object.entries(ex ?? {}).filter(([, v]) => v !== "workspace:*");
    const got = Object.entries(pinned ?? {});
    if (JSON.stringify(expected.map(([k]) => k)) !== JSON.stringify(got.map(([k]) => k))) {
      out.push(`${section}: template ${got.map(([k]) => k).join(", ")} vs example ${expected.map(([k]) => k).join(", ")}`);
    }
    for (const [pkg, range] of expected) {
      const pin = pinned?.[pkg];
      if (pin === undefined) continue;
      if (!/^\d+\.\d+\.\d+$/.test(pin)) out.push(`${section}.${pkg}: '${pin}' is not an exact pin`);
      const major = /^\^?(\d+)/.exec(range)?.[1];
      if (major !== pin.split(".")[0]) out.push(`${section}.${pkg}: pin ${pin} is outside the example's range ${range}`);
    }
  }
  return out;
}

/** Line comments dropped and blank runs collapsed: TN-26-012 §6 compares
 *  emitted files with the example modulo comments. */
export function withoutComments(text: string): string {
  return text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n").replace(/\n{3,}/g, "\n\n");
}
