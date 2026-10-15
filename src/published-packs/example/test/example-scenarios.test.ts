// bounded-example's example scenarios (ADR 2026-031): every example of its
// packs (packs/<pack>/examples/<slug>.config.ts) is opened as a project's
// bounded.config.ts, bounded-example installed beside bounded, and every
// step of its scenarios (<slug>.scenarios.ts) is judged there. This is the
// route a published pack's package outside this repository takes: its own
// test runs its scenarios with bounded/testing/example-scenarios.
import { afterAll, describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodePackModules } from "bounded/adapters";
import { runExampleScenarios } from "bounded/testing/example-scenarios";

/** This package's directory, src/published-packs/example. */
const PACKAGE = resolve(import.meta.dir, "..");
/** Every example of the package's packs: packs/<pack>/examples/<slug>.config.ts. */
const examplePaths = [...new Glob("packs/*/examples/*.config.ts").scanSync({ cwd: PACKAGE })].sort();
const STATE_HOME = mkdtempSync(join(tmpdir(), "bounded-example-scenarios-state-"));
afterAll(() => rmSync(STATE_HOME, { recursive: true, force: true }));

describe("bounded-example's example scenarios", () => {
  test("every example of bounded-example holds its scenarios, step by step, installed beside bounded", async () => {
    expect(examplePaths.length).toBeGreaterThan(0);
    for (const examplePath of examplePaths) {
      const scenariosPath = examplePath.replace(/\.config\.ts$/, ".scenarios.ts");
      const loaded = await new NodePackModules().loadDefaultExport(PACKAGE, scenariosPath);
      expect({ scenariosPath, loaded: loaded.ok ? "loaded" : loaded.error }).toEqual({ scenariosPath, loaded: "loaded" });
      if (!loaded.ok) continue;
      const report = await runExampleScenarios({ examplePath: join(PACKAGE, examplePath), scenarios: loaded.value, linkedPackages: { "bounded-example": PACKAGE }, stateHome: STATE_HOME, ports: () => [] });
      expect({ examplePath, problem: report.problem }).toEqual({ examplePath, problem: null });
      expect({ examplePath, scenarios: report.scenarios.length > 0 }).toEqual({ examplePath, scenarios: true });
      for (const scenario of report.scenarios) {
        expect({ examplePath, scenario: scenario.title, problem: scenario.problem }).toEqual({ examplePath, scenario: scenario.title, problem: null });
        for (const step of scenario.steps) expect({ examplePath, scenario: scenario.title, step: step.number, actual: step.actual }).toEqual({ examplePath, scenario: scenario.title, step: step.number, actual: step.expected });
      }
    }
  });
});
