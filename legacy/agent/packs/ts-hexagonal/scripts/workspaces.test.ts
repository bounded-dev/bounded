import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { WorkspaceTemplate } from "../../ts/pack.ts";
import { CONTEXT_TEMPLATE, contracts, SCOPE, TECHNOLOGIES } from "./testdata/example-contracts.ts";
import { deriveWorkspaces, readContracts, readProjectFacts } from "./workspaces.ts";

const template = (kind: string, root = "apps"): WorkspaceTemplate =>
  ({ pack: "p", kind, root, manifest: "m.json", files: [], description: kind });
const TEMPLATES = [CONTEXT_TEMPLATE, template("web"), template("mcp"), template("lambdas")];
const design = (apps: Record<string, string> = {}, sources = contracts()) =>
  ({ scope: SCOPE, contracts: sources, apps, templates: TEMPLATES });

describe("deriveWorkspaces", () => {
  test("contexts come from contract paths and apps from the TN map, sorted by directory", () => {
    const workspaces = deriveWorkspaces(design({ "apps/web": "web", "apps/mcp": "mcp" }));
    expect(workspaces.map((w) => [w.dir, w.kind, w.packageName, w.sourceRoot, w.contracts.length])).toEqual([
      ["apps/mcp", "mcp", "@example/mcp", "apps/mcp/src", 0],
      ["apps/web", "web", "@example/web", "apps/web/src", 0],
      ["contexts/project-management", "context", "@example/project-management", "contexts/project-management/src", 11],
    ]);
  });

  test("a context's contracts are sorted by path, whatever order they arrive in", () => {
    const [context] = deriveWorkspaces(design({}, [...contracts()].reverse()));
    const paths = context!.contracts.map((c) => c.path);
    expect(paths).toEqual([...paths].sort());
  });

  test("two contexts are two workspaces", () => {
    const billing = { path: "contexts/billing/src/domain/invoices/invoice-id.contract.ts", source: "" };
    expect(deriveWorkspaces(design({}, [...contracts(), billing])).map((w) => w.dir)).toEqual([
      "contexts/billing", "contexts/project-management",
    ]);
  });

  test.each([
    [{ "apps/web": "context" }, /contexts come from contract paths/],
    [{ "apps/web": "desktop" }, /no composed pack templates/],
    [{ "web": "web" }, /must be 'apps\/<kebab-case name>'/],
    [{ "tools/web": "web" }, /must be 'apps\/<kebab-case name>'/],
    [{ "apps/Web": "web" }, /must be 'apps\/<kebab-case name>'/],
    [{ "apps/web/src": "web" }, /must be 'apps\/<kebab-case name>'/],
    [{ "contexts/project-management": "web" }, /must be 'apps\/<kebab-case name>'/],
  ])("the app map %j is refused", (apps, message) => {
    expect(() => deriveWorkspaces(design(apps as Record<string, string>))).toThrow(message);
  });

  test("an app and a context with one name would be one package, and are refused", () => {
    const templates = [...TEMPLATES, template("tool", "tools")];
    expect(() => deriveWorkspaces({ ...design(), apps: { "apps/project-management": "web" }, templates }))
      .toThrow(/would both be the package @example\/project-management/);
  });

  test("contracts outside a context, a bad scope, or no context template are refused", () => {
    expect(() => deriveWorkspaces(design({}, [{ path: "apps/web/src/x.contract.ts", source: "" }]))).toThrow(/contexts\/<context>\/src/);
    expect(() => deriveWorkspaces(design({}, [{ path: "contexts/Billing/src/x.contract.ts", source: "" }]))).toThrow(/not a kebab-case/);
    expect(() => deriveWorkspaces({ ...design(), scope: "example" })).toThrow(/scope 'example'/);
    expect(() => deriveWorkspaces({ ...design(), templates: [] })).toThrow(/no composed pack templates the 'context'/);
  });

  test("a design with nothing in it has no workspaces", () => {
    expect(deriveWorkspaces({ scope: SCOPE, contracts: [], apps: {}, templates: [] })).toEqual([]);
  });
});

describe("readProjectFacts", () => {
  const dirs: string[] = [];
  afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

  test("walks every context's source root for contracts, skipping node_modules and non-contracts", () => {
    const project = mkdtempSync(join(tmpdir(), "hex-facts-"));
    dirs.push(project);
    for (const { path, source } of contracts()) {
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), source);
    }
    mkdirSync(join(project, "contexts/project-management/src/node_modules/x"), { recursive: true });
    writeFileSync(join(project, "contexts/project-management/src/node_modules/x/y.contract.ts"), "");
    writeFileSync(join(project, "contexts/project-management/src/domain/notes/note.ts"), "");
    expect(readContracts(project)).toEqual(contracts());
    const facts = readProjectFacts(project, {
      scope: SCOPE, phase: "design", packs: ["ts", "ts-hexagonal"], apps: { "apps/web": "web" },
      adapterTechnologies: [...TECHNOLOGIES].reverse(), workspaceTemplates: [...TEMPLATES].reverse(),
    });
    expect(facts.workspaces.map((w) => w.dir)).toEqual(["apps/web", "contexts/project-management"]);
    expect(facts.adapterTechnologies.map((t) => t.id)).toEqual(TECHNOLOGIES.map((t) => t.id));
    expect(facts.workspaceTemplates.map((t) => t.kind)).toEqual(["context", "lambdas", "mcp", "web"]);
  });

  test("a project with no contexts directory has no contracts", () => {
    const project = mkdtempSync(join(tmpdir(), "hex-empty-"));
    dirs.push(project);
    expect(readContracts(project)).toEqual([]);
  });
});
