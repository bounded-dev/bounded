import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { PIPELINE_ROLES } from "../../src/path-gate.ts";
import { ARTIFACT_GATE_TOOLS, GATE_TOOLS, ROLE_TOOLS, type Role } from "../../src/path-policy.ts";
import { cliGates, gateCommand } from "./bash-policy.ts";
import {
  claudeTools,
  GENERATED_MARKER,
  hookCommandFor,
  isGenerated,
  PI_TO_CLAUDE_TOOLS,
  readPiAgent,
  renderAgent,
  renderAllAgents,
} from "./render-agents.ts";
import { CLAUDE_CONDITIONAL_TOOLS, CLAUDE_PROVIDED_TOOLS } from "./tool-map.ts";
import { SCOUT_CLAUDE_TOOLS } from "./project-install.ts";
import { SEARCH_USAGE } from "./search.ts";

// ADR LEG-2026-034: "Drift tests extend to the rendered Claude Code agent
// definitions: `tools:` allowlists are pinned to ROLE_TOOLS." This is
// agent-config-drift.test.ts for the second host — the same pins, through the
// one mapping, so the two hosts cannot grant a role two different toolsets.

const HARNESS_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Extract the YAML frontmatter block (between the first two `---` lines). */
function frontmatter(source: string): string {
  const lines = source.split(/\r?\n/);
  const fences: number[] = [];
  for (let i = 0; i < lines.length && fences.length < 2; i++) {
    if (lines[i].trim() === "---") fences.push(i);
  }
  if (fences.length < 2) throw new Error("no frontmatter block found");
  return lines.slice(fences[0] + 1, fences[1]).join("\n");
}

function field(fm: string, key: string): string | undefined {
  const line = fm.split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  return line === undefined ? undefined : line.slice(key.length + 1).trim();
}

function toolList(fm: string): string[] {
  const raw = field(fm, "tools");
  if (raw === undefined) throw new Error("no tools field");
  return raw.split(",").map((t) => t.trim()).filter((t) => t !== "");
}

/** The mapped allowlist, computed independently of claudeTools(). */
function expectedTools(role: Role): string[] {
  return [...new Set(ROLE_TOOLS[role].flatMap((t) => PI_TO_CLAUDE_TOOLS[t] ?? []))];
}

describe("PI_TO_CLAUDE_TOOLS — the one mapping", () => {
  test("covers every tool any role holds", () => {
    for (const role of PIPELINE_ROLES) {
      for (const tool of ROLE_TOOLS[role]) expect(PI_TO_CLAUDE_TOOLS[tool], tool).toBeDefined();
    }
  });
  test("every gate, and every bash carrier, maps to Bash", () => {
    for (const gate of GATE_TOOLS) expect(PI_TO_CLAUDE_TOOLS[gate]).toEqual(["Bash"]);
    for (const gate of ARTIFACT_GATE_TOOLS) expect(PI_TO_CLAUDE_TOOLS[gate]).toEqual(["Bash"]);
    for (const role of PIPELINE_ROLES) for (const gate of cliGates(role)) expect(PI_TO_CLAUDE_TOOLS[gate]).toEqual(["Bash"]);
    for (const carrier of ["remove", "git", "sleep"]) expect(PI_TO_CLAUDE_TOOLS[carrier]).toEqual(["Bash"]);
  });
  test("the file tools and subagent map to their Claude Code tools", () => {
    expect(PI_TO_CLAUDE_TOOLS).toMatchObject({
      read: ["Read"],
      grep: ["Bash"],
      find: ["Bash"],
      ls: ["Bash"],
      write: ["Write"],
      edit: ["Edit"],
      subagent: ["Agent", "SendMessage"],
    });
  });
  test("every Claude Code tool in the mapping is one the host provides to every subagent", () => {
    for (const [pi, claude] of Object.entries(PI_TO_CLAUDE_TOOLS)) {
      for (const tool of claude) expect(CLAUDE_PROVIDED_TOOLS.has(tool), `${pi} → ${tool}`).toBe(true);
    }
  });
  test("Glob and Grep are not counted as provided: native builds drop them unless the launch names them", () => {
    for (const tool of CLAUDE_CONDITIONAL_TOOLS) expect(CLAUDE_PROVIDED_TOOLS.has(tool)).toBe(false);
  });
  test("bash itself is not in the mapping: no role's ROLE_TOOLS names it", () => {
    expect(PI_TO_CLAUDE_TOOLS["bash"]).toBeUndefined();
  });
});

describe("rendered Claude Code agent definitions", () => {
  const rendered = renderAllAgents({ harnessRoot: HARNESS_ROOT });

  test("one definition per pipeline role", () => {
    expect(Object.keys(rendered).sort()).toEqual([...PIPELINE_ROLES].sort());
  });

  for (const role of PIPELINE_ROLES) {
    describe(role, () => {
      const source = rendered[role];
      const fm = frontmatter(source);

      test("tools exactly equals ROLE_TOOLS mapped through PI_TO_CLAUDE_TOOLS, deduplicated, in order", () => {
        expect(toolList(fm)).toEqual(expectedTools(role));
        expect(toolList(fm)).toEqual([...claudeTools(role)]);
      });

      // #35: the definition names exactly the tools the host really gives the
      // role. A tools: entry the host lacks is a capability the brief promises
      // and the role does not have — the 2026-10-01 dogfood architect listed
      // Glob, was refused it, and guessed paths instead.
      test("names only tools the host provides to every subagent", () => {
        for (const tool of toolList(fm)) expect(CLAUDE_PROVIDED_TOOLS.has(tool), tool).toBe(true);
      });

      test("the host preamble names no tool the definition does not hold", () => {
        const preamble = source.slice(fm.length, source.indexOf("\n---\n", fm.length + 8));
        for (const tool of [...CLAUDE_PROVIDED_TOOLS, ...CLAUDE_CONDITIONAL_TOOLS]) {
          if (!toolList(fm).includes(tool)) expect(preamble, tool).not.toMatch(new RegExp(`\\b(?:the )?${tool} tool\\b`));
        }
      });

      test("the host preamble teaches content search through Bash, with the role's blindness rule", () => {
        const preamble = source.slice(fm.length, source.indexOf("\n---\n", fm.length + 8));
        expect(preamble).toContain(`\`${SEARCH_USAGE}\` through Bash`);
        if (role === "builder") expect(preamble).toContain("keeps it off test files");
        if (role === "test-writer") expect(preamble).toContain("keeps it off implementation files");
      });

      test("the host preamble says how to list names, so no path is ever guessed", () => {
        const preamble = source.slice(fm.length, source.indexOf("\n---\n", fm.length + 8));
        expect(preamble).toContain("`ls [<dir>]` through Bash");
        expect(preamble).toContain("`find <dir> -name '<glob>'` through Bash");
        expect(preamble).toContain("never guess a path");
      });

      test("name and description come from the pi definition", () => {
        expect(field(fm, "name")).toBe(role);
        const desc: unknown = JSON.parse(field(fm, "description") ?? "null");
        expect(desc).toBe(readPiAgent(HARNESS_ROOT, role).description);
      });

      test("the hooks block binds this host's hook with --role", () => {
        expect(fm).toContain("hooks:\n  PreToolUse:\n    - matcher: \"\"\n      hooks:\n        - type: command\n          command: ");
        const command: unknown = JSON.parse(field(fm, "          command") ?? "null");
        expect(command).toBe(hookCommandFor(HARNESS_ROOT, role));
        expect(command).toContain("hosts/claude-code/path-gate-hook.ts");
        expect(command).toMatch(new RegExp(` --role ${role}$`));
      });

      test("carries the generated marker, inside the frontmatter", () => {
        expect(isGenerated(source)).toBe(true);
        expect(fm).toContain(GENERATED_MARKER);
        expect(source.slice(source.indexOf("\n---", 4))).not.toContain(GENERATED_MARKER);
      });

      test("the pi brief body is present verbatim, below a rule", () => {
        const body = readPiAgent(HARNESS_ROOT, role).body;
        expect(body.length).toBeGreaterThan(200);
        expect(source).toContain(`\n---\n\n${body}\n`);
      });

      test("the host preamble names each gate the role holds as a bounded gates command, and no other", () => {
        const preamble = source.slice(fm.length, source.indexOf("\n---\n", fm.length + 8));
        expect(preamble).toContain("## This host: Claude Code");
        for (const gate of cliGates(role)) expect(preamble).toContain(`\`bounded gates ${gateCommand(gate)}\``);
        for (const gate of GATE_TOOLS) {
          if (!ROLE_TOOLS[role].includes(gate)) expect(preamble).not.toContain(`\`bounded gates ${gateCommand(gate)}\``);
        }
        expect(preamble).toContain("Bash is refused for anything else");
        expect(preamble).toContain("the hook prefixes `BOUNDED_HOST=claude-code BOUNDED_DEV_STAGE_ROLE=<role>` itself");
      });

      // (b2) `subagent` and `git` belong to the architect alone: no worker
      // may hold Agent, or a worker could launder its blindness through a child.
      if (role !== "architect") {
        test("no worker role holds Agent or SendMessage", () => {
          expect(toolList(fm)).not.toContain("Agent");
          expect(toolList(fm)).not.toContain("SendMessage");
        });
        test("a worker's hook runs only before its calls", () => {
          expect(fm).not.toContain("PostToolUse");
        });
      } else {
        test("the architect holds Agent, SendMessage and Bash", () => {
          expect(toolList(fm)).toEqual(expect.arrayContaining(["Agent", "SendMessage", "Bash"]));
        });
        test("the architect's hook also runs after Agent and SendMessage, to record workers", () => {
          for (const event of ["PostToolUse", "PostToolUseFailure"]) {
            expect(fm).toContain(`  ${event}:\n    - matcher: "Agent|Task|SendMessage"\n      hooks:\n        - type: command\n          command: ${JSON.stringify(hookCommandFor(HARNESS_ROOT, role))}`);
          }
        });
        test("the preamble tells the architect to continue a worker with SendMessage", () => {
          expect(source).toContain("Continuing a worker that already ran (a bounce) → the SendMessage tool");
        });
      }

      // (b3) The reviewer holds no pen.
      if (role === "reviewer") {
        test("the reviewer holds neither Write nor Edit", () => {
          expect(toolList(fm)).not.toContain("Write");
          expect(toolList(fm)).not.toContain("Edit");
        });
      }
    });
  }

  test("the generated scout names only tools the host provides", () => {
    for (const tool of SCOUT_CLAUDE_TOOLS) expect(CLAUDE_PROVIDED_TOOLS.has(tool), tool).toBe(true);
  });

  test("hookCommand override is honoured verbatim", () => {
    const source = renderAgent("builder", { harnessRoot: HARNESS_ROOT, hookCommand: "pi-cc-hook --role builder" });
    expect(field(frontmatter(source), "          command")).toBe(JSON.stringify("pi-cc-hook --role builder"));
  });

  test("the pi agents on disk still say what this test assumes about their shape", () => {
    // The source of the description and body is the pi definition; if its
    // frontmatter grows a multi-line description this parser must change.
    for (const role of PIPELINE_ROLES) {
      const raw = readFileSync(fileURLToPath(new URL(`../../agents/${role}.md`, import.meta.url)), "utf8");
      expect(raw.startsWith("---\n")).toBe(true);
      expect(raw).toMatch(/\ndescription: \S/);
    }
  });
});
