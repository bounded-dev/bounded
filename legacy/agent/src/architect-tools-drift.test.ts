import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import installArchitectTools from "../hosts/pi/extensions/architect-tools.ts";
import installDevTools from "../hosts/pi/extensions/dev-tools.ts";
import { gates } from "../packs/ts/gates.ts";
import { DESIGN_STEPS } from "../packs/ts/scripts/design-gate.ts";
import { ARCHITECT_UTILITY_TOOLS, GATE_TOOLS, ROLE_TOOLS } from "./path-policy.ts";

// The architect has no `bash`, so every capability it needs must exist as a
// registered tool. That makes the tool NAMES load-bearing in a way they were
// not before: a name in ROLE_TOOLS that nothing registers is not a lint error
// or a type error — it is an architect that silently cannot run a gate,
// discovered live, mid-run, at the worst moment.
//
// So pin the two lists against each other. `path-policy.ts` is the authority
// on what the architect may hold; the extensions are the authority on what
// exists; this test is the only thing that makes them agree.

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: { readonly properties?: Record<string, unknown>; readonly required?: readonly string[] };
}

/** The schema as the model sees it: JSON, no TypeBox bookkeeping. */
function asJson(schema: unknown): unknown {
  return JSON.parse(JSON.stringify(schema));
}

/** Minimal ExtensionAPI stub: records the tools an extension registers. */
function registeredTools(install: (pi: never) => void): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool(spec: RegisteredTool) {
      tools.push(spec);
    },
    on() {
      /* extensions may install hooks; irrelevant here */
    },
  };
  install(pi as never);
  return tools;
}

function registeredNames(install: (pi: never) => void): string[] {
  return registeredTools(install).map((t) => t.name);
}

describe("architect tool registration matches the path policy", () => {
  const architectTools = registeredNames(installArchitectTools);

  test("every gate named in GATE_TOOLS is actually registered", () => {
    for (const name of GATE_TOOLS) {
      expect(architectTools, `${name} is in GATE_TOOLS but nothing registers it`).toContain(name);
    }
  });

  test("git is registered — it is the architect's only route to the repo", () => {
    expect(architectTools).toContain("git");
  });

  // The two non-gate tools are registered here too, so the exact-equality pin
  // has to know about them — and naming them separately from GATE_TOOLS is the
  // point: neither is a verdict a phase can turn on.
  test("sleep and mutation_score are registered — the architect's two non-gate tools", () => {
    for (const tool of ARCHITECT_UTILITY_TOOLS) {
      expect(architectTools, `${tool} is in ARCHITECT_UTILITY_TOOLS but nothing registers it`).toContain(tool);
    }
  });

  test("registers nothing beyond the gates, git, and the two utilities", () => {
    expect([...architectTools].sort()).toEqual(
      [...GATE_TOOLS, "git", ...ARCHITECT_UTILITY_TOOLS].sort(),
    );
  });

  // `sleep` is a WAIT, not a verdict. r15's architect, with no wait primitive
  // and a stalled reviewer, used design_gate as a clock — five gate runs and
  // four junk scaffolds to pass time, which left the gate record describing a
  // project nobody had changed. So the description has to say what the tool is
  // for AND what it replaces, because the substitution it prevents is one the
  // model reasoned its way into out loud.
  test("the sleep description names the wait and forbids the gate-as-clock", () => {
    const sleep = registeredTools(installArchitectTools).find((t) => t.name === "sleep");
    expect(sleep).toBeDefined();
    expect(sleep!.description).toMatch(/subagent|child|poll/i);
    expect(sleep!.description).toMatch(/never call a gate to pass time/i);
  });

  // Advisory means advisory: a description that read as a gate would put the
  // architect on a hunt to make a number go up, and there is no threshold.
  test("the mutation_score description says it never blocks", () => {
    const mutation = registeredTools(installArchitectTools).find((t) => t.name === "mutation_score");
    expect(mutation).toBeDefined();
    expect(mutation!.description).toMatch(/advisory/i);
    expect(mutation!.description).toMatch(/never blocks|exit 0/i);
  });

  // The full allowlist has to resolve: built-ins (read/write/…), pi's own
  // `subagent`, the builder's tools from dev-tools, and the architect's own.
  test("every tool in ROLE_TOOLS.architect exists as a builtin or a registration", () => {
    const BUILTIN = ["read", "grep", "find", "ls", "write", "edit", "subagent"];
    const available = new Set([...BUILTIN, ...registeredNames(installDevTools), ...architectTools]);
    for (const tool of ROLE_TOOLS.architect) {
      expect(available, `ROLE_TOOLS.architect names '${tool}' but nothing provides it`).toContain(
        tool,
      );
    }
  });

  // Tools that were RETIRED must not linger. `scaffold` and `freeze_contracts`
  // became steps of `design_gate` (ADR 2026-019), and a step that is still
  // separately callable is a step that can still be called out of order — which
  // is the whole thing the composite removes. The exact-equality test above
  // would catch a stray registration; this one says why it is wrong.
  test("the tools folded into design_gate are gone, and the composite exists", () => {
    expect(architectTools).toContain("design_gate");
    for (const retired of ["scaffold", "freeze_contracts"]) {
      expect(architectTools, `'${retired}' is a step of design_gate, not a tool`).not.toContain(
        retired,
      );
      expect(GATE_TOOLS, `'${retired}' is a step of design_gate, not a tool`).not.toContain(retired);
    }
    // The cheap single check survives: iterating on a contract should not cost
    // a scaffold, a typecheck and a freeze.
    expect(architectTools).toContain("contract_purity");
  });

  // The architect has no `bash` and does not read the gate scripts — the tool
  // DESCRIPTION is the whole interface. A step that can block the phase and is
  // named nowhere in it is a block arriving from a step the architect did not
  // know ran.
  test("the design_gate description names every step it runs", () => {
    const design = registeredTools(installArchitectTools).find((t) => t.name === "design_gate");
    expect(design).toBeDefined();
    const missing = DESIGN_STEPS.filter((step) => !design!.description.includes(step));
    expect(missing).toEqual([]);
  });

  // The tools come from the registry now, so the parameter schema is derived
  // rather than written — and a derivation can drop what the hand-written
  // schema said. Pin the two places it matters: the findings item schema is
  // exactly what the model used to read, and the repeatable pattern flag is an
  // array named as before.
  test("sign_off's findings parameter is the item schema the model always read", () => {
    const signOff = registeredTools(installArchitectTools).find((t) => t.name === "sign_off");
    expect(signOff).toBeDefined();
    expect(signOff!.parameters.required).toEqual(["findings"]);
    expect(asJson(signOff!.parameters.properties?.["findings"])).toEqual(
      asJson(
        Type.Array(
          Type.Object({
            severity: Type.Union([Type.Literal("blocker"), Type.Literal("concern"), Type.Literal("note")], {
              description: "blocker | concern | note",
            }),
            summary: Type.String({ description: "One line: what is wrong." }),
            evidence: Type.Optional(Type.String({ description: "Where to look — a path, a symbol, a test name." })),
          }),
          { description: "What you saw. Pass [] to record that you found nothing." },
        ),
      ),
    );
  });

  test("contract_purity and design_gate take `patterns` as an optional array of strings", () => {
    for (const name of ["contract_purity", "design_gate"]) {
      const tool = registeredTools(installArchitectTools).find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(Object.keys(tool!.parameters.properties ?? {}).sort(), name).toEqual(["cwd", "patterns"]);
      expect(tool!.parameters.required ?? [], name).toEqual([]);
      expect(asJson(tool!.parameters.properties?.["patterns"]), name).toMatchObject({
        type: "array",
        items: { type: "string" },
      });
    }
  });

  // A flag the registry marks cliOnly is for a person at a shell. Offered to a
  // model it is a hole: `role` would let a worker choose its own scoping, and a
  // findings file is a path a blind role could point at anything.
  test("no registered tool exposes a cliOnly flag", () => {
    const registered = [...registeredTools(installArchitectTools), ...registeredTools(installDevTools)];
    const cliOnly = gates.flatMap((g) => g.flags.filter((f) => f.cliOnly === true));
    expect(cliOnly.length).toBeGreaterThan(0);
    for (const tool of registered) {
      const params = Object.keys(tool.parameters.properties ?? {});
      for (const flag of cliOnly) {
        for (const spelling of [flag.name, flag.param ?? flag.name, "findingsFile", "findings_file"]) {
          expect(params, `${tool.name} exposes '${spelling}'`).not.toContain(spelling);
        }
      }
    }
    const typecheck = registered.find((t) => t.name === "typecheck");
    expect(Object.keys(typecheck!.parameters.properties ?? {})).toEqual(["cwd"]);
  });

  // The worker roles must never be handed one of these by a copy-paste.
  test("no architect gate leaks into a worker role's allowlist", () => {
    for (const role of ["test-writer", "builder", "reviewer"] as const) {
      for (const gate of [...GATE_TOOLS, ...ARCHITECT_UTILITY_TOOLS, "git", "subagent"]) {
        expect(ROLE_TOOLS[role], `${role} must not hold '${gate}'`).not.toContain(gate);
      }
    }
  });

  // The reviewer's tool is the mirror image: it belongs to that role alone, for
  // the same reason `run_tests` belongs to the builder alone. An architect
  // recording a review of its own spec is the first reading again, not a
  // second one — and that is the gap the role exists to close.
  test("record_design_review is the reviewer's alone", () => {
    expect(ROLE_TOOLS.reviewer).toContain("record_design_review");
    for (const role of ["architect", "test-writer", "builder"] as const) {
      expect(ROLE_TOOLS[role], `${role} must not hold 'record_design_review'`).not.toContain(
        "record_design_review",
      );
    }
  });

  test("change_diff is a read-only reviewer capability", () => {
    expect(ROLE_TOOLS.reviewer).toContain("change_diff");
    for (const role of ["architect", "test-writer", "builder"] as const) {
      expect(ROLE_TOOLS[role], `${role} must not hold 'change_diff'`).not.toContain("change_diff");
    }
  });

  // The reviewer holds no pen but that one: no write, no edit, no remove, and
  // no shell to work around them with.
  test("the reviewer's allowlist is read-only", () => {
    for (const pen of ["write", "edit", "remove", "bash"]) {
      expect(ROLE_TOOLS.reviewer, `reviewer must not hold '${pen}'`).not.toContain(pen);
    }
  });

  // Same pin as the architect's, for every role: a tool a role is allowed to
  // hold but nothing registers is an instruction to make a call that cannot
  // succeed, discovered live and mid-run.
  test("every tool in every role's allowlist exists as a builtin or a registration", () => {
    const BUILTIN = ["read", "grep", "find", "ls", "write", "edit", "subagent"];
    const available = new Set([...BUILTIN, ...registeredNames(installDevTools), ...architectTools]);
    for (const [role, tools] of Object.entries(ROLE_TOOLS)) {
      for (const tool of tools) {
        expect(available, `ROLE_TOOLS.${role} names '${tool}' but nothing provides it`).toContain(
          tool,
        );
      }
    }
  });
});
