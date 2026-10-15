import { describe, expect, test } from "bun:test";
import { Effect } from "../events/effect.ts";
import { ProjectPath } from "../events/project-path.ts";
import { Verdict } from "../verdicts/verdict.ts";
import type { ExampleScenariosJSON } from "./example-scenarios.contract.ts";
import { defineExampleScenarios, ExampleScenarios } from "./example-scenarios.ts";

/** A whole set of scenarios in the normal form: every step kind, a search (a list and a read) and an execute command. */
const normal = {
  scenarios: [
    {
      title: "Review the plan before building",
      projectFiles: { "plan.md": "the plan\n", "src/a.ts": "export const a = 1;\n" },
      steps: [
        { toolUse: { role: null, tool: "write", effects: [{ kind: "write", path: "src/a.ts", change: "modify" }] }, verdict: { kind: "refuse", reason: "No review yet", redirect: "Review the plan" } },
        { toolUse: { role: null, tool: "subagent", effects: [{ kind: "delegate", agent: "reviewer" }], callId: "r1" }, verdict: { kind: "allow" } },
        {
          toolResult: { role: null, tool: "subagent", effects: [{ kind: "delegate", agent: "reviewer" }], ok: true, callId: "r1", delegatedAgentRuns: [{ finished: true, resolvedAgent: "reviewer" }] },
          afterToolMessage: null,
        },
        { changeFiles: { "plan.md": "the plan, edited\n", "src/a.ts": null } },
        {
          toolUse: {
            role: "builder",
            tool: "search",
            effects: [
              { kind: "list", root: "src", filter: "*.ts" },
              { kind: "read", path: "src" },
            ],
          },
          verdict: { kind: "allow" },
        },
        { toolUse: { role: null, tool: "shell", effects: [{ kind: "execute", command: "make build", cwd: "apps/web" }], callId: "m1" }, verdict: { kind: "allow" } },
      ],
    },
  ],
};

/** One scenario holding `steps`, titled "t". */
const oneScenario = (steps: readonly unknown[], more: Record<string, unknown> = {}) => ({ scenarios: [{ title: "t", steps, ...more }] });
/** A tool use step reading README.md, allowed. */
const readStep = { toolUse: { tool: "read", effects: [{ kind: "read", path: "README.md" }] }, verdict: { kind: "allow" } };
/** Why `raw` is refused, or "accepted". */
const refusal = (raw: unknown): string => {
  const parsed = ExampleScenarios.parse(raw);
  return parsed.ok ? "accepted" : parsed.error;
};
/** The normal form `raw` parses to; it throws when it is refused. */
const normalFormOf = (raw: unknown): unknown => {
  const parsed = ExampleScenarios.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value.toJSON();
};
/** The error a parser gives `raw`. */
const errorOf = (result: { readonly ok: true } | { readonly ok: false; readonly error: string }): string => (result.ok ? "accepted" : result.error);
/** A read reading's wire form, for building an execute effect Effect.parse takes. */
const READ = { outcome: "read", programs: [], fileEffects: [], unresolved: [] };

describe("ExampleScenarios — an example's scenarios as data (ADR 2026-031)", () => {
  test("parses tool uses, a tool result and a change of files, and gives back the same wire form", () => {
    expect(normalFormOf(normal)).toEqual(normal);
    const parsed = ExampleScenarios.parse(normal);
    expect(parsed.ok && JSON.parse(JSON.stringify(parsed.value))).toEqual(normal);
    expect(parsed.ok && parsed.value.scenarios.map(({ title }) => title)).toEqual(["Review the plan before building"]);
  });

  test("fills in the normal form: a list's filter and an execute command's cwd left out come back null", () => {
    const given = oneScenario([
      { toolUse: { tool: "search", effects: [{ kind: "list", root: "src" }] }, verdict: { kind: "allow" } },
      { toolUse: { tool: "shell", effects: [{ kind: "execute", command: "make" }] }, verdict: { kind: "allow" } },
    ]);
    expect(normalFormOf(given)).toEqual({
      scenarios: [
        {
          title: "t",
          projectFiles: {},
          steps: [
            { toolUse: { role: null, tool: "search", effects: [{ kind: "list", root: "src", filter: null }] }, verdict: { kind: "allow" } },
            { toolUse: { role: null, tool: "shell", effects: [{ kind: "execute", command: "make", cwd: null }] }, verdict: { kind: "allow" } },
          ],
        },
      ],
    });
  });

  test("refuses no scenarios, a scenario with no steps, and a scenario with no tool use, naming the scenario by number and title", () => {
    for (const raw of [{}, { scenarios: [] }, { scenarios: "none" }, "scenarios"]) expect({ raw, error: refusal(raw) }).toEqual({ raw, error: expect.stringContaining("at least one scenario") });
    const second = (scenario: unknown) => ({ scenarios: [{ title: "first", steps: [readStep] }, scenario] });
    expect(refusal(second({ title: "second" }))).toBe("Scenario 2 ('second') has no steps: give it a list of steps, at least one of them a tool use");
    expect(refusal(second({ title: "second", steps: [] }))).toBe("Scenario 2 ('second') has no steps: give it a list of steps, at least one of them a tool use");
    expect(refusal(second({ title: "second", steps: [{ changeFiles: { "a.txt": "a\n" } }] }))).toBe("Scenario 2 ('second') has no tool use: each scenario judges at least one tool use, { toolUse, verdict }");
    expect(refusal(second("second"))).toBe("Scenario 2 is an object { title, projectFiles?, steps }");
  });

  test("refuses a tool use without its verdict, a refusal with a blank reason or redirect, and a tool result without afterToolMessage, naming the step", () => {
    const at = (step: number, error: string) => `Scenario 1 ('t'), step ${step}: ${error}`;
    expect(refusal(oneScenario([readStep, { toolUse: readStep.toolUse }]))).toBe(at(2, "a tool use step gives the verdict it expects: { toolUse, verdict }"));
    const verdictError = errorOf(Verdict.parse({ kind: "refuse", reason: " ", redirect: "x" }));
    expect(verdictError).not.toBe("accepted");
    expect(refusal(oneScenario([{ ...readStep, verdict: { kind: "refuse", reason: " ", redirect: "x" } }]))).toBe(at(1, verdictError));
    expect(refusal(oneScenario([{ ...readStep, verdict: { kind: "refuse", reason: "x", redirect: "" } }]))).toBe(at(1, errorOf(Verdict.parse({ kind: "refuse", reason: "x", redirect: "" }))));
    const result = { tool: "read", effects: [{ kind: "read", path: "README.md" }], ok: true };
    const noMessage = at(2, "a tool result step gives the message it expects after the tool, or null: { toolResult, afterToolMessage }");
    expect(refusal(oneScenario([readStep, { toolResult: result }]))).toBe(noMessage);
    expect(refusal(oneScenario([readStep, { toolResult: result, afterToolMessage: 3 }]))).toBe(noMessage);
    expect(refusal(oneScenario([readStep, { toolResult: result, afterToolMessage: "Read." }]))).toBe("accepted");
  });

  test("a step's parts are refused with their own parsers' messages", () => {
    const at = (error: string) => `Scenario 1 ('t'), step 1: ${error}`;
    expect(refusal(oneScenario([{ toolUse: { tool: "hammer", effects: [{ kind: "read", path: "a" }] }, verdict: { kind: "allow" } }]))).toBe(
      at("Tool kind 'hammer' is not one of: read, search, edit, write, shell, web, subagent, other"),
    );
    expect(refusal(oneScenario([{ toolUse: { tool: "read", effects: [{ kind: "read" }] }, verdict: { kind: "allow" } }]))).toBe(at(`Effect 1 of 1: ${errorOf(Effect.parse({ kind: "read" }))}`));
    expect(refusal(oneScenario([readStep, { toolResult: { tool: "read", effects: [{ kind: "read", path: "a" }], ok: "yes" }, afterToolMessage: null }]))).toBe(
      "Scenario 1 ('t'), step 2: A tool result says whether the tool succeeded: ok is true or false",
    );
    const twoRuns = { tool: "subagent", effects: [{ kind: "delegate", agent: "a" }], ok: true, delegatedAgentRuns: [{ finished: true }, { finished: true }] };
    expect(refusal(oneScenario([readStep, { toolResult: twoRuns, afterToolMessage: null }]))).toBe(
      "Scenario 1 ('t'), step 2: A tool result's delegatedAgentRuns has one entry per delegate effect: 1 effect, 2 entries",
    );
    expect(refusal(oneScenario([{ ...readStep, verdict: { kind: "maybe" } }]))).toBe(at(errorOf(Verdict.parse({ kind: "maybe" }))));
    expect(refusal(oneScenario([{ toolUse: { tool: "shell", effects: [{ kind: "execute", command: "" }] }, verdict: { kind: "allow" } }]))).toBe(
      at(`Effect 1 of 1: ${errorOf(Effect.parse({ kind: "execute", command: "", reading: READ }))}`),
    );
  });

  test("an execute command is exactly kind, command and cwd: a reading or any other field is refused", () => {
    const executing = (effect: Record<string, unknown>) => oneScenario([{ toolUse: { tool: "shell", effects: [effect] }, verdict: { kind: "allow" } }]);
    expect(refusal(executing({ kind: "execute", command: "make", cwd: "apps" }))).toBe("accepted");
    expect(refusal(executing({ kind: "execute", command: "make", reading: READ }))).toBe(
      "Scenario 1 ('t'), step 1: Effect 1 of 1: a scenario's execute effect is a command bounded reads when the scenario runs: leave its reading out",
    );
    expect(refusal(executing({ kind: "execute", command: "make", shell: "bash" }))).toBe("Scenario 1 ('t'), step 1: Effect 1 of 1: a scenario's execute effect is { kind, command, cwd? }, with no field 'shell'");
    expect(refusal(oneScenario([{ ...readStep, toolUse: { ...readStep.toolUse, kind: "tool-use" } }]))).toBe(
      "Scenario 1 ('t'), step 1: a scenario's tool use has no field 'kind': it is { role?, tool, effects, callId? }",
    );
    const result = { kind: "tool-result", tool: "read", effects: [{ kind: "read", path: "a" }], ok: true };
    expect(refusal(oneScenario([readStep, { toolResult: result, afterToolMessage: null }]))).toBe(
      "Scenario 1 ('t'), step 2: a scenario's tool result has no field 'kind': it is { role?, tool, effects, ok, callId?, delegatedAgentRuns? }",
    );
  });

  test("refuses a step with two kinds, an agent run's finish, an unknown step and an unknown field", () => {
    const at = (error: string) => `Scenario 1 ('t'), step 2: ${error}`;
    const KINDS = "a step is one of { toolUse, verdict }, { toolResult, afterToolMessage } or { changeFiles }";
    expect(refusal(oneScenario([readStep, { ...readStep, changeFiles: { "a.txt": "a" } }]))).toBe(at(`${KINDS}, not toolUse and changeFiles together`));
    expect(refusal(oneScenario([readStep, { agentRunFinished: { agentRunId: "run-1" } }]))).toBe(at(`a step has no field 'agentRunFinished': ${KINDS}`));
    expect(refusal(oneScenario([readStep, {}]))).toBe(at(KINDS));
    expect(refusal(oneScenario([readStep, "read"]))).toBe(at(KINDS));
    expect(refusal(oneScenario([readStep, { ...readStep, note: "why" }]))).toBe(at("a tool use step has no field 'note': it is { toolUse, verdict }"));
    expect(refusal(oneScenario([readStep, { changeFiles: { "a.txt": "a" }, verdict: { kind: "allow" } }]))).toBe(at("a change of files has no field 'verdict': it is { changeFiles }"));
    expect(refusal({ ...oneScenario([readStep]), extra: true })).toBe("Example scenarios have no field 'extra': they are { scenarios }");
    expect(refusal(oneScenario([readStep], { notes: "x" }))).toBe("Scenario 1 ('t') has no field 'notes': a scenario is { title, projectFiles?, steps }");
  });

  test("refuses project files and changed files where Bounded keeps its own, whatever their case; .git and node_modules are no concern of the domain's", () => {
    const owned = "is where Bounded keeps its own files (the project's bounded.config.* at its root, .bounded/): a scenario writes no file there";
    for (const path of ["bounded.config.ts", "Bounded.Config.mjs", ".bounded/prereqs/records.jsonl", ".BOUNDED/x", ".bounded"]) {
      expect({ path, error: refusal(oneScenario([readStep], { projectFiles: { [path]: "x" } })) }).toEqual({ path, error: `Scenario 1 ('t')'s project file '${path}' ${owned}` });
      expect({ path, error: refusal(oneScenario([readStep, { changeFiles: { [path]: null } }])) }).toEqual({ path, error: `Scenario 1 ('t'), step 2: changed file '${path}' ${owned}` });
    }
    for (const path of ["/etc/x", "../x"]) {
      const error = refusal(oneScenario([readStep], { projectFiles: { [path]: "x" } }));
      expect({ path, error }).toEqual({ path, error: `Scenario 1 ('t')'s project file '${path}': ${errorOf(ProjectPath.parse(path))}` });
      expect({ path, error: refusal(oneScenario([readStep, { changeFiles: { [path]: "x" } }])) }).toEqual({ path, error: `Scenario 1 ('t'), step 2: changed file '${path}': ${errorOf(ProjectPath.parse(path))}` });
    }
    // A git-hooks pack ships a scenario whose project holds a hook; the runner, not the domain, keeps node_modules/ for itself.
    expect(refusal(oneScenario([readStep], { projectFiles: { ".git/hooks/pre-commit": "#!/bin/sh\n" } }))).toBe("accepted");
    for (const path of ["src/bounded.config.ts", "docs/.git-notes", ".git/config", ".Git/hooks/x", "node_modules/x/y", "Node_Modules/x"]) {
      expect({ path, error: refusal(oneScenario([readStep], { projectFiles: { [path]: "x" } })) }).toEqual({ path, error: "accepted" });
      expect({ path, error: refusal(oneScenario([readStep, { changeFiles: { [path]: null } }])) }).toEqual({ path, error: "accepted" });
    }
    expect(refusal(oneScenario([readStep], { projectFiles: { "a.txt": 1 } }))).toBe("Scenario 1 ('t')'s project file 'a.txt' is text");
    expect(refusal(oneScenario([readStep], { projectFiles: ["a.txt"] }))).toBe("Scenario 1 ('t')'s projectFiles maps project paths to their text");
    expect(refusal(oneScenario([readStep, { changeFiles: { "a.txt": 1 } }]))).toBe("Scenario 1 ('t'), step 2: changed file 'a.txt' is its new text, or null to delete it");
    expect(refusal(oneScenario([readStep, { changeFiles: {} }]))).toBe("Scenario 1 ('t'), step 2: a change of files names at least one file");
    expect(refusal(oneScenario([readStep, { changeFiles: "a.txt" }]))).toBe("Scenario 1 ('t'), step 2: a change of files maps project paths to their new text, or null to delete them");
  });

  test("refuses the project's root as a file, and a file named twice, naming it", () => {
    expect(refusal(oneScenario([readStep], { projectFiles: { ".": "x" } }))).toBe("Scenario 1 ('t')'s project file '.' is the project's root, not a file");
    expect(refusal(oneScenario([readStep, { changeFiles: { "./": null } }]))).toBe("Scenario 1 ('t'), step 2: changed file './' is the project's root, not a file");
    expect(refusal(oneScenario([readStep], { projectFiles: { "a.txt": "a", "./a.txt": "b" } }))).toBe("Scenario 1 ('t')'s project file './a.txt' is named twice, as 'a.txt'");
    expect(refusal(oneScenario([readStep, { changeFiles: { "src/a.ts": null, "src//a.ts": "b" } }]))).toBe("Scenario 1 ('t'), step 2: changed file 'src//a.ts' is named twice, as 'src/a.ts'");
  });

  test("refuses a blank or multi-line title", () => {
    for (const title of ["", "  ", "two\nlines", 3, undefined]) {
      expect({ title, error: refusal({ scenarios: [{ title, steps: [readStep] }] }) }).toEqual({ title, error: "Scenario 1's title is one line of text, not blank" });
    }
  });

  test("renders each step: its effects and call id, then → allowed, or → refused: the reason with its redirect", () => {
    const given = {
      scenarios: [
        {
          title: "Review before building",
          projectFiles: { "plan.md": "the plan\n", "src/a.ts": "a\n" },
          steps: [
            { toolUse: { tool: "write", effects: [{ kind: "write", path: "src/a.ts", change: "modify" }] }, verdict: { kind: "refuse", reason: "No review yet", redirect: "Review the plan" } },
            { toolUse: { tool: "subagent", effects: [{ kind: "delegate", agent: "reviewer" }], callId: "r1" }, verdict: { kind: "allow" } },
            {
              toolResult: { tool: "subagent", effects: [{ kind: "delegate", agent: "reviewer" }], callId: "r1", ok: true, delegatedAgentRuns: [{ finished: true, resolvedAgent: "reviewer" }] },
              afterToolMessage: null,
            },
            { changeFiles: { "plan.md": "edited\n", "src/a.ts": null } },
            {
              toolUse: {
                tool: "shell",
                effects: [
                  { kind: "execute", command: "make build", cwd: "apps/web" },
                  { kind: "read", path: "README.md" },
                ],
              },
              verdict: { kind: "allow" },
            },
          ],
        },
        {
          title: "A failed fetch",
          steps: [
            { toolUse: { tool: "web", effects: [{ kind: "fetch", url: "https://example.com" }], callId: "f1" }, verdict: { kind: "allow" } },
            { toolResult: { tool: "web", effects: [{ kind: "fetch", url: "https://example.com" }], callId: "f1", ok: false }, afterToolMessage: "Fetched nothing" },
            { changeFiles: { "x.txt": null } },
          ],
        },
      ],
    };
    const parsed = ExampleScenarios.parse(given);
    expect(parsed.ok ? parsed.value.markdown() : parsed.error).toBe(
      [
        "### Review before building",
        "",
        "Project files: `plan.md`, `src/a.ts`.",
        "",
        "1. write (modify) src/a.ts → refused: No review yet",
        "   Redirect: Review the plan",
        "2. delegate to reviewer (call r1) → allowed",
        "3. Result of delegate to reviewer (call r1), succeeded; reviewer's run finished → no message",
        "4. Files changed: `plan.md`; deleted: `src/a.ts`.",
        "5. execute `make build` in apps/web; read README.md → allowed",
        "",
        "### A failed fetch",
        "",
        "1. fetch https://example.com (call f1) → allowed",
        "2. Result of fetch https://example.com (call f1), failed → message: Fetched nothing",
        "3. Files deleted: `x.txt`.",
      ].join("\n"),
    );
  });

  test("defineExampleScenarios returns plain data, frozen all the way down", () => {
    const given: ExampleScenariosJSON = { scenarios: [{ title: "t", projectFiles: { "a.txt": "a\n" }, steps: [{ toolUse: { tool: "shell", effects: [{ kind: "execute", command: "make" }] }, verdict: { kind: "allow" } }] }] };
    const defined = defineExampleScenarios(given);
    expect(defined).toBe(given);
    const frozenAllTheWay = (value: unknown): boolean =>
      typeof value !== "object" || value === null || (Object.isFrozen(value) && [Object.prototype, Array.prototype].includes(Object.getPrototypeOf(value)) && Object.values(value).every(frozenAllTheWay));
    expect(frozenAllTheWay(defined)).toBe(true);
    expect(ExampleScenarios.parse(defined).ok).toBe(true);
  });
});
