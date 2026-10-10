// The schemas bounded's package catalogue gives each shipped pack's data
// point (ADR 2026-026: the compile-time wire shape, generated from the wire
// type the pack's contract gives) agree with the packs' run-time checks:
// every wire form the packs' own tests accept validates, every value the
// shipped examples contribute validates, and what does not compile is
// rejected.
//
// This test and src/cli/bounded-cli.catalog-bounded.test.ts both write the
// shared, gitignored src/bounded.catalog.json, by running the built CLI's
// `bounded catalog build` in src/. They rely on `bun test` running test files
// one after another, and each rebuilds the file before reading it.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Ajv } from "ajv";
import { FileSystemProjectConfigSource } from "bounded/adapters";
import { prereqs, PrerequisiteRule } from "bounded/prereqs";
import { ProtectedPath, protectedPathsPack } from "bounded/protected-paths";
import { prerequisiteRuleWireForms } from "../../packs/prereqs/domain/prerequisite-rule.wire-forms.test-support.ts";
import { protectedPathWireForms } from "../../packs/protected-paths/domain/protected-path.wire-forms.test-support.ts";

/** bounded's directory, src/: the package whose catalogue is built, and what a project's node_modules/bounded links to. */
const BOUNDED = resolve(import.meta.dir, "../..");
const ajv = new Ajv({ strict: false, allErrors: true });

interface CataloguedPoint {
  readonly key: string;
  readonly wire: { readonly type: string; readonly schema: Record<string, unknown> } | null;
}
interface CataloguedPack {
  readonly id: string;
  readonly points: readonly CataloguedPoint[];
}

/** bounded's catalogue, rebuilt now by the built CLI under Node; the packs it lists, or none when the build failed. */
function builtCatalogue(): { readonly packs: readonly CataloguedPack[]; readonly output: string } {
  const ran = spawnSync("node", [join(BOUNDED, "dist", "cli.js"), "catalog", "build"], { cwd: BOUNDED, encoding: "utf8" });
  const output = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
  if (ran.status !== 0) return { packs: [], output };
  const catalogue: unknown = JSON.parse(readFileSync(join(BOUNDED, "bounded.catalog.json"), "utf8"));
  const packs = typeof catalogue === "object" && catalogue !== null && "packs" in catalogue && Array.isArray(catalogue.packs) ? (catalogue.packs as CataloguedPack[]) : [];
  return { packs, output };
}
const catalogue = builtCatalogue();

/** The schema the catalogue gives a pack's point; it throws when there is none. */
function schemaOf(packId: string, key: string): Record<string, unknown> {
  const schema = catalogue.packs.find((pack) => pack.id === packId)?.points.find((point) => point.key === key)?.wire?.schema;
  if (schema === undefined) throw new Error(`the catalogue gives ${packId}.${key} no schema: ${catalogue.output}`);
  return schema;
}
/** Whether `value` validates against the schema of a pack's point, with ajv's errors when it does not. */
function validates(packId: string, key: string, value: unknown): { readonly valid: boolean; readonly errors: string } {
  const validate = ajv.compile(schemaOf(packId, key));
  const valid = validate(value);
  return { valid, errors: ajv.errorsText(validate.errors) };
}

/** A git project whose bounded.config.ts is `config`, with bounded installed as a link to src/. */
function projectWithConfig(config: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-wire-schema-")));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(BOUNDED, join(root, "node_modules", "bounded"), "dir");
  writeFileSync(join(root, "bounded.config.ts"), config);
  return root;
}

describe("the package catalogue's schemas for the shipped packs' points", () => {
  test("every wire form the pack's own tests accept validates against its schema", () => {
    expect(catalogue.output).toContain("Wrote bounded.catalog.json");
    const cases = [
      { packId: "bounded/prereqs", key: "rules", forms: prerequisiteRuleWireForms, parse: (raw: unknown) => PrerequisiteRule.parse(raw).ok },
      { packId: "bounded/protected-paths", key: "protectedPaths", forms: protectedPathWireForms, parse: (raw: unknown) => ProtectedPath.parse(raw).ok },
    ];
    for (const { packId, key, forms, parse } of cases) {
      expect({ packId, forms: forms.length > 0 }).toEqual({ packId, forms: true });
      for (const form of forms) {
        expect({ packId, form, parsed: parse(form) }).toEqual({ packId, form, parsed: true });
        expect({ packId, form, ...validates(packId, key, form) }).toEqual({ packId, form, valid: true, errors: "No errors" });
      }
    }
  });

  test("every value the examples contribute validates", async () => {
    const examplePaths = [...new Glob("packs/*/examples/*.config.ts").scanSync({ cwd: BOUNDED })].sort();
    expect(examplePaths.length).toBeGreaterThan(0);
    for (const examplePath of examplePaths) {
      // The example is read as text and opened as a project's configuration: nothing imports it.
      const root = projectWithConfig(readFileSync(join(BOUNDED, examplePath), "utf8"));
      const loaded = await new FileSystemProjectConfigSource().load(root);
      expect({ example: examplePath, loaded: loaded.ok ? "ok" : loaded.error }).toEqual({ example: examplePath, loaded: "ok" });
      if (!loaded.ok) continue;
      const composed = loaded.value.compose();
      expect({ example: examplePath, composed: composed.ok ? "ok" : composed.error }).toEqual({ example: examplePath, composed: "ok" });
      if (!composed.ok) continue;
      const rules = composed.value.read(prereqs.points.rules);
      const protectedPaths = composed.value.read(protectedPathsPack.points.protectedPaths);
      const contributed = [
        ...(rules.ok ? rules.value.map((rule) => ({ packId: "bounded/prereqs", key: "rules", wire: rule.toJSON() })) : []),
        ...(protectedPaths.ok ? protectedPaths.value.map((path) => ({ packId: "bounded/protected-paths", key: "protectedPaths", wire: path.toJSON() })) : []),
      ];
      expect({ example: examplePath, contributes: contributed.length > 0 }).toEqual({ example: examplePath, contributes: true });
      for (const { packId, key, wire } of contributed) expect({ example: examplePath, wire, ...validates(packId, key, wire) }).toEqual({ example: examplePath, wire, valid: true, errors: "No errors" });
    }
  });

  test("the schemas reject what does not compile", () => {
    const path = { match: "secrets/**", deny: ["read"], redirect: "Ask a maintainer" };
    const { redirect: _redirect, ...withoutRedirect } = path;
    for (const rejected of [{ ...path, deny: ["write"] }, withoutRedirect, { ...path, allow: ["read"] }, { ...path, deny: [] }]) {
      expect({ rejected, valid: validates("bounded/protected-paths", "protectedPaths", rejected).valid }).toEqual({ rejected, valid: false });
    }
    const rule = { before: { write: "src/**" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the plan" };
    expect(validates("bounded/prereqs", "rules", rule).valid).toBe(true);
    for (const rejected of [{ ...rule, require: { delegate: "plan-reviewer", succeeded: false } }, { ...rule, unchangedSince: [] }, { ...rule, before: { run: "x" } }, { ...rule, after: { write: "docs/**" } }]) {
      expect({ rejected, valid: validates("bounded/prereqs", "rules", rejected).valid }).toEqual({ rejected, valid: false });
    }
  });

  test("the generator's rendering of `?: undefined` keeps a before to exactly one action", () => {
    const rule = { require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the plan" };
    expect(validates("bounded/prereqs", "rules", { ...rule, before: { delegate: "a" } }).valid).toBe(true);
    expect(validates("bounded/prereqs", "rules", { ...rule, before: { delegate: "a", write: "b" } }).valid).toBe(false);
    expect(validates("bounded/prereqs", "rules", { ...rule, before: { write: "a", execute: "b" } }).valid).toBe(false);
    expect(PrerequisiteRule.parse({ ...rule, before: { delegate: "a", write: "b" } }).ok).toBe(false);
  });
});
