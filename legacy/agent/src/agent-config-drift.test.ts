import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ROLE_TOOLS, ZONES, type Role } from "./path-policy.js";

// TN-26-001 Phase 3: the pipeline agent definitions are configuration,
// and configuration drifts. This test pins each worker's frontmatter to the
// canonical ROLE_TOOLS data so a hand-edit to an agent .md that widens its
// authority (adds `bash`, `subagent`, or a tool the role shouldn't hold) is a
// red test, not a silent capability grant. The tool allowlist is the only
// enforcement layer that PREVENTS rather than detects — so it is the one most
// worth guarding against drift.

const ROLES = ["architect", "test-writer", "builder", "reviewer"] as const;

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

/** Read a `key:` value from the frontmatter (rest of the line, trimmed). */
function field(fm: string, key: string): string | undefined {
  const line = fm.split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  return line === undefined ? undefined : line.slice(key.length + 1).trim();
}

/** Parse `tools:` as a comma-separated list. */
function toolList(fm: string): string[] {
  const raw = field(fm, "tools");
  if (raw === undefined) throw new Error("no tools field");
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

function readAgent(role: Role): string {
  return frontmatter(
    readFileSync(fileURLToPath(new URL(`../agents/${role}.md`, import.meta.url)), "utf8"),
  );
}

describe("developer-stage agent config drift", () => {
  // (d) the roster of pipeline agents equals the ZONES keys — no agent .md
  // exists for a role the path policy doesn't know, and vice versa.
  test("the pipeline roles equal the ZONES keys", () => {
    expect([...ROLES].sort()).toEqual(Object.keys(ZONES).sort());
    expect([...ROLES].sort()).toEqual(Object.keys(ROLE_TOOLS).sort());
  });

  for (const role of ROLES) {
    describe(role, () => {
      const fm = readAgent(role);

      // (a) tools EXACTLY equals ROLE_TOOLS[role] — order and membership.
      test("tools exactly equals ROLE_TOOLS", () => {
        expect(toolList(fm)).toEqual([...ROLE_TOOLS[role]]);
      });

      // (b) NO role holds bash, ever — a shell defeats every path rule at
      // once, so even the architect gets named tools instead.
      test("has no bash", () => {
        expect(toolList(fm)).not.toContain("bash");
      });

      // (b2) `subagent` and `git` belong to the architect alone. The two blind
      // roles must hold neither: `subagent` would let a worker launder its
      // blindness through a child, and `git show HEAD:tests/x.test.ts` hands
      // the builder the test source in a single call.
      if (role !== "architect") {
        test("no worker role holds subagent or git", () => {
          const tools = toolList(fm);
          expect(tools).not.toContain("subagent");
          expect(tools).not.toContain("git");
        });
      }

      // (b3) The reviewer holds NO pen. It reads the design before the freeze
      // and records findings; a reviewer that could edit what it found would be
      // a second author of the spec and the contract, which is exactly the
      // thing the role exists to avoid.
      if (role === "reviewer") {
        test("the reviewer holds no write tool and no write zone", () => {
          const tools = toolList(fm);
          for (const pen of ["write", "edit", "remove"]) expect(tools).not.toContain(pen);
          expect(ZONES.reviewer.writeAllow).toEqual([]);
        });
      }

      // (c) subagentOnlyExtensions binds the matching per-role path-gate loader.
      test("subagentOnlyExtensions points at the role's path-gate loader", () => {
        const ext = field(fm, "subagentOnlyExtensions");
        expect(ext).toBeDefined();
        expect(ext!.endsWith(`path-gate/${role}.ts`)).toBe(true);
      });
    });
  }
});
