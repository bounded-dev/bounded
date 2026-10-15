// Every shipped pack's example scenarios (ADR 2026-031): each example
// (src/packs/<name>/examples/<slug>.config.ts) is opened as a project's
// bounded.config.ts, and every step of its scenarios
// (<slug>.scenarios.ts, beside it) is judged there, its expected verdict or
// message checked. Nothing imports an example or its scenarios: the
// scenarios are loaded as the catalogue build loads them, and run with
// bounded/testing/example-scenarios, with the shipped packs' ports and
// bounded's shell command reader, as a host has them.
import { afterAll, describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodePackModules } from "bounded/adapters";
import { prereqsPortProvisions } from "bounded/prereqs/adapters";
import { protectedPathsPortProvisions } from "bounded/protected-paths/adapters";
import { runExampleScenarios } from "bounded/testing/example-scenarios";
import { openShellCommandReading } from "bounded-shell-command-reader/shell-command-reading";

/** bounded's directory, src/. */
const BOUNDED = resolve(import.meta.dir, "..");
/** Every shipped pack's example, from src/: packs/<name>/examples/<slug>.config.ts. */
const examplePaths = [...new Glob("packs/*/examples/*.config.ts").scanSync({ cwd: BOUNDED })].sort();
/** The state home the shipped packs' ports are given: a temporary directory, never the user's. */
const STATE_HOME = mkdtempSync(join(tmpdir(), "bounded-example-scenarios-state-"));
afterAll(() => rmSync(STATE_HOME, { recursive: true, force: true }));

describe("shipped packs' example scenarios", () => {
  test("every shipped example's scenarios hold, step by step, opened as a project's bounded.config.ts with the shipped packs' ports and bounded's shell command reader", async () => {
    expect(examplePaths.length).toBeGreaterThan(0);
    const shellCommandReading = openShellCommandReading({ readWithinMs: 30_000, prepareWithinMs: 30_000 });
    await shellCommandReading.prepare();
    for (const examplePath of examplePaths) {
      const scenariosPath = examplePath.replace(/\.config\.ts$/, ".scenarios.ts");
      const loaded = await new NodePackModules().loadDefaultExport(BOUNDED, scenariosPath);
      expect({ scenariosPath, loaded: loaded.ok ? "loaded" : loaded.error }).toEqual({ scenariosPath, loaded: "loaded" });
      if (!loaded.ok) continue;
      const report = await runExampleScenarios({
        examplePath: join(BOUNDED, examplePath),
        scenarios: loaded.value,
        linkedPackages: {},
        stateHome: STATE_HOME,
        ports: ({ stateHome }) => [...protectedPathsPortProvisions(stateHome), ...prereqsPortProvisions()],
        shellCommandReading,
      });
      expect({ examplePath, problem: report.problem }).toEqual({ examplePath, problem: null });
      expect({ examplePath, scenarios: report.scenarios.length > 0 }).toEqual({ examplePath, scenarios: true });
      for (const scenario of report.scenarios) {
        expect({ examplePath, scenario: scenario.title, problem: scenario.problem }).toEqual({ examplePath, scenario: scenario.title, problem: null });
        expect({ examplePath, scenario: scenario.title, steps: scenario.steps.length > 0 }).toEqual({ examplePath, scenario: scenario.title, steps: true });
        for (const step of scenario.steps) expect({ examplePath, scenario: scenario.title, step: step.number, actual: step.actual }).toEqual({ examplePath, scenario: scenario.title, step: step.number, actual: step.expected });
      }
    }
  }, 120_000);
});
