// The example scenarios runner (ADR 2026-031), published as
// bounded/testing/example-scenarios: it opens an example as a scenario's
// project's bounded.config.ts, bounded linked as the package it ships in and
// the example's own package linked under its name, and judges each step.
// The fixture refusing-package (src/core/test/fixtures/example-scenarios/)
// is a package of one pack that refuses every write; its scenarios are
// loaded as the catalogue build loads them. The reader here is a recording
// fake, so these tests need no shell command reader.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodePackModules } from "bounded/adapters";
import { ExampleScenarios } from "bounded/domain";
import { runExampleScenarios } from "./run-example-scenarios.test-support.ts";

/** bounded's directory, src/: what each scenario's project links node_modules/bounded to. */
const BOUNDED = realpathSync(resolve(import.meta.dir, "../.."));
const REFUSING_PACKAGE = join(BOUNDED, "core", "test", "fixtures", "example-scenarios", "refusing-package");
const EXAMPLE = join(REFUSING_PACKAGE, "packs", "refusing", "examples", "refuse-writes.config.ts");
const SCENARIOS = "packs/refusing/examples/refuse-writes.scenarios.ts";

const temporaryDirectories: string[] = [];
afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});
/** A fresh temporary directory, removed after the tests. */
function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "bounded-run-example-scenarios-")));
  temporaryDirectories.push(directory);
  return directory;
}

/** The fixture's scenarios, loaded as the catalogue build loads them. */
async function fixtureScenarios(): Promise<unknown> {
  const loaded = await new NodePackModules().loadDefaultExport(REFUSING_PACKAGE, SCENARIOS);
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.value;
}

interface ReadInput {
  readonly projectRoot: string;
  readonly command: string;
  readonly cwd: string | null;
}
/** A fake shell command reader: every command reads as running nothing, and each call is recorded with what `observe` sees in the project then. */
function recordingReader(observe: (input: ReadInput) => unknown = () => null) {
  const calls: { readonly input: ReadInput; readonly observed: unknown }[] = [];
  return {
    calls,
    async read(input: ReadInput): Promise<unknown> {
      calls.push({ input, observed: observe(input) });
      return { outcome: "read", programs: [], fileEffects: [], unresolved: [] };
    },
  };
}
/** A spy for the runner's ports option: it records each state home it is given and provides no port. */
function portsSpy() {
  const stateHomes: string[] = [];
  return {
    stateHomes,
    ports: ({ stateHome }: { readonly stateHome: string }) => {
      stateHomes.push(stateHome);
      return [];
    },
  };
}
/** A tool use step running `command`, allowed. */
const commandStep = (command: string, cwd: string | null = null) => ({ toolUse: { tool: "shell", effects: [{ kind: "execute", command, cwd }] }, verdict: { kind: "allow" } });
const readStep = { toolUse: { tool: "read", effects: [{ kind: "read", path: "README.md" }] }, verdict: { kind: "allow" } };

describe("runExampleScenarios", () => {
  test("runs a package's example with bounded and its own package linked under their names", async () => {
    const reader = recordingReader(({ projectRoot }) => realpathSync(join(projectRoot, "node_modules", "bounded")));
    const spy = portsSpy();
    const report = await runExampleScenarios({
      examplePath: EXAMPLE,
      scenarios: await fixtureScenarios(),
      linkedPackages: { "refusing-package": REFUSING_PACKAGE },
      stateHome: temporaryDirectory(),
      ports: spy.ports,
      shellCommandReading: reader,
    });
    expect(report.problem).toBeNull();
    expect(report.examplePath).toBe(EXAMPLE);
    expect(report.scenarios.map(({ title, problem }) => ({ title, problem }))).toEqual([{ title: "A write is refused; a read and a command are allowed", problem: null }]);
    const steps = report.scenarios[0]?.steps ?? [];
    expect(steps.map(({ number }) => number)).toEqual([1, 2, 3, 4]);
    for (const step of steps) expect({ step: step.number, actual: step.actual }).toEqual({ step: step.number, actual: step.expected });
    expect(steps[3]?.actual).toEqual({ verdict: { kind: "refuse", reason: "refusing-package/refusing refused write (create) src/a.ts: this pack refuses every write", redirect: "Write nothing here" } });
    expect(steps[2]?.actual).toEqual({ afterToolMessage: null });
    // bounded is linked to the bounded the runner ships in; the reader saw it from inside the scenario's project.
    expect(reader.calls.length).toBeGreaterThan(0);
    for (const call of reader.calls) expect(call.observed).toBe(BOUNDED);
  });

  test("reports a step whose verdict differs from the one expected, with both", async () => {
    const report = await runExampleScenarios({
      examplePath: EXAMPLE,
      scenarios: { scenarios: [{ title: "Expects a write allowed", steps: [readStep, { toolUse: { tool: "write", effects: [{ kind: "write", path: "a.txt", change: "create" }] }, verdict: { kind: "allow" } }] }] },
      linkedPackages: { "refusing-package": REFUSING_PACKAGE },
      stateHome: temporaryDirectory(),
    });
    expect(report.problem).toBeNull();
    expect(report.scenarios[0]?.steps).toEqual([
      { number: 1, expected: { verdict: { kind: "allow" } }, actual: { verdict: { kind: "allow" } } },
      {
        number: 2,
        expected: { verdict: { kind: "allow" } },
        actual: { verdict: { kind: "refuse", reason: "refusing-package/refusing refused write (create) a.txt: this pack refuses every write", redirect: "Write nothing here" } },
      },
    ]);
  });

  test("reports an example that does not open, with its problem, and runs no step", async () => {
    const reader = recordingReader();
    const report = await runExampleScenarios({ examplePath: EXAMPLE, scenarios: await fixtureScenarios(), stateHome: temporaryDirectory(), shellCommandReading: reader });
    expect(report.problem).toBeNull();
    expect(report.scenarios.length).toBe(1);
    for (const scenario of report.scenarios) {
      expect(scenario.problem).toContain("refusing-package");
      expect(scenario.steps).toEqual([]);
    }
    expect(reader.calls).toEqual([]);
  });

  test("reads each command in the scenario's project at that step, with the reader it is given", async () => {
    const reader = recordingReader();
    const report = await runExampleScenarios({
      examplePath: EXAMPLE,
      scenarios: {
        scenarios: [
          { title: "Two commands", steps: [commandStep("make build", "apps"), readStep, commandStep("make test")] },
          { title: "One command", steps: [commandStep("ls")] },
        ],
      },
      linkedPackages: { "refusing-package": REFUSING_PACKAGE },
      stateHome: temporaryDirectory(),
      shellCommandReading: reader,
    });
    expect(report.scenarios.map(({ problem }) => problem)).toEqual([null, null]);
    expect(reader.calls.map(({ input }) => ({ command: input.command, cwd: input.cwd }))).toEqual([
      { command: "make build", cwd: "apps" },
      { command: "make test", cwd: null },
      { command: "ls", cwd: null },
    ]);
    const [first, second, third] = reader.calls.map(({ input }) => input.projectRoot);
    expect(first).toBe(second ?? "");
    expect(third).not.toBe(first ?? "");
    for (const root of [first, third]) expect(root?.startsWith("/")).toBe(true);
    for (const scenario of report.scenarios) for (const step of scenario.steps) expect(step.actual).toEqual(step.expected);
  });

  test("writes and deletes files between steps", async () => {
    const reader = recordingReader(({ projectRoot }) => existsSync(join(projectRoot, "notes", "a.txt")));
    const report = await runExampleScenarios({
      examplePath: EXAMPLE,
      scenarios: {
        scenarios: [
          {
            title: "A file comes and goes",
            steps: [commandStep("cat notes/a.txt"), { changeFiles: { "notes/a.txt": "a\n" } }, commandStep("cat notes/a.txt"), { changeFiles: { "notes/a.txt": null } }, commandStep("cat notes/a.txt")],
          },
        ],
      },
      linkedPackages: { "refusing-package": REFUSING_PACKAGE },
      stateHome: temporaryDirectory(),
      shellCommandReading: reader,
    });
    expect(report.scenarios[0]?.problem).toBeNull();
    expect(reader.calls.map(({ observed }) => observed)).toEqual([false, true, false]);
    expect(report.scenarios[0]?.steps.map(({ number }) => number)).toEqual([1, 3, 5]);
  });

  test("gives ports the state home it was given and leaves it; one it made is removed", async () => {
    const given = temporaryDirectory();
    const withHome = portsSpy();
    await runExampleScenarios({ examplePath: EXAMPLE, scenarios: await fixtureScenarios(), linkedPackages: { "refusing-package": REFUSING_PACKAGE }, stateHome: given, ports: withHome.ports, shellCommandReading: recordingReader() });
    expect(withHome.stateHomes).toEqual([given]);
    expect(existsSync(given)).toBe(true);
    const withoutHome = portsSpy();
    await runExampleScenarios({ examplePath: EXAMPLE, scenarios: await fixtureScenarios(), linkedPackages: { "refusing-package": REFUSING_PACKAGE }, ports: withoutHome.ports, shellCommandReading: recordingReader() });
    expect(withoutHome.stateHomes.length).toBe(1);
    const made = withoutHome.stateHomes[0] ?? "";
    expect(made).not.toBe(given);
    expect(made.startsWith("/")).toBe(true);
    expect(existsSync(made)).toBe(false);
  });

  test("removes its temporary projects, without following the links", async () => {
    const reader = recordingReader();
    await runExampleScenarios({ examplePath: EXAMPLE, scenarios: await fixtureScenarios(), linkedPackages: { "refusing-package": REFUSING_PACKAGE }, stateHome: temporaryDirectory(), shellCommandReading: reader });
    const roots = reader.calls.map(({ input }) => input.projectRoot);
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) expect({ root, exists: existsSync(root) }).toEqual({ root, exists: false });
    expect(existsSync(join(REFUSING_PACKAGE, "package.json"))).toBe(true);
    expect(existsSync(join(BOUNDED, "package.json"))).toBe(true);
    expect(existsSync(EXAMPLE)).toBe(true);
  });

  test("a scenario that runs a shell command without a reader ends with that problem, and runs none of its steps", async () => {
    const report = await runExampleScenarios({
      examplePath: EXAMPLE,
      scenarios: { scenarios: [{ title: "Runs a command", steps: [readStep, commandStep("make")] }, { title: "Only reads", steps: [readStep] }] },
      linkedPackages: { "refusing-package": REFUSING_PACKAGE },
      stateHome: temporaryDirectory(),
    });
    expect(report.problem).toBeNull();
    expect(report.scenarios).toEqual([
      { title: "Runs a command", problem: "this scenario runs a shell command: pass shellCommandReading", steps: [] },
      { title: "Only reads", problem: null, steps: [{ number: 1, expected: { verdict: { kind: "allow" } }, actual: { verdict: { kind: "allow" } } }] },
    ]);
  });

  test("scenarios that do not parse are reported with the parser's error, and no project is opened", async () => {
    const unparseable = { scenarios: [{ title: "No verdict", steps: [{ toolUse: readStep.toolUse }] }] };
    const parsed = ExampleScenarios.parse(unparseable);
    expect(parsed.ok).toBe(false);
    const spy = portsSpy();
    const reader = recordingReader();
    const report = await runExampleScenarios({ examplePath: EXAMPLE, scenarios: unparseable, linkedPackages: { "refusing-package": REFUSING_PACKAGE }, ports: spy.ports, shellCommandReading: reader });
    expect(report).toEqual({ examplePath: EXAMPLE, problem: parsed.ok ? "parsed" : parsed.error, scenarios: [] });
    expect(spy.stateHomes).toEqual([]);
    expect(reader.calls).toEqual([]);
  });

  test("refuses a linkedPackages entry for bounded, which the runner links itself", async () => {
    const spy = portsSpy();
    const report = await runExampleScenarios({
      examplePath: EXAMPLE,
      scenarios: await fixtureScenarios(),
      linkedPackages: { bounded: BOUNDED, "refusing-package": REFUSING_PACKAGE },
      ports: spy.ports,
      shellCommandReading: recordingReader(),
    });
    expect(report.scenarios).toEqual([]);
    expect(report.problem).toContain("bounded");
    expect(report.problem).toContain("linkedPackages");
    expect(spy.stateHomes).toEqual([]);
  });
});
