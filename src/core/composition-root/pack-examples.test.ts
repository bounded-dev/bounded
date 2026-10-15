// Every shipped pack's examples (src/packs/<name>/examples/<slug>.config.ts,
// ADRs 2026-009 and 2026-013) are complete project configurations. Nothing
// imports an example: each is read as text and opened as a project's
// bounded.config.ts, as a project would open it, so an example cannot drift
// from the API.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { prereqsPortProvisions } from "bounded/prereqs/adapters";
import { protectedPathsPortProvisions } from "bounded/protected-paths/adapters";
import * as ts from "typescript";
import { openProject } from "./open-project.ts";
import { readingOf } from "./shell-command-reading-samples.test-support.ts";

/** bounded's directory, src/: what a project's node_modules/bounded links to. */
const BOUNDED = resolve(import.meta.dir, "../..");
const PACKS = join(BOUNDED, "packs");
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "bounded-state-"));

/** Every shipped pack's directory name under src/packs/. */
const shippedPackNames = readdirSync(PACKS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
/** Every example of a shipped pack, from src/: packs/<name>/examples/<slug>.config.ts. */
const examplePaths = [...new Glob("packs/*/examples/*.config.ts").scanSync({ cwd: BOUNDED })].sort();

/**
 * A git project whose bounded.config.ts is `config`, with bounded installed as a link to src/,
 * and `files` (project-relative path -> text) written with their directories.
 */
function projectWithConfig(config: string, files: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-example-")));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(BOUNDED, join(root, "node_modules", "bounded"), "dir");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.bounded/\n");
  writeFileSync(join(root, "bounded.config.ts"), config);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  spawnSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

/** The text of the TSDoc on a file's `export default`, or undefined when it has none. */
function defaultExportTsDoc(path: string, text: string): string | undefined {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const exportDefault = source.statements.find((statement): statement is ts.ExportAssignment => ts.isExportAssignment(statement) && statement.isExportEquals !== true);
  if (exportDefault === undefined) return undefined;
  const docs = ts.getJSDocCommentsAndTags(exportDefault).filter((doc): doc is ts.JSDoc => ts.isJSDoc(doc));
  const doc = docs.at(-1);
  return doc === undefined ? undefined : (ts.getTextOfJSDocComment(doc.comment) ?? "");
}

describe("shipped packs' examples", () => {
  test("each shipped pack has at least one example", () => {
    expect(shippedPackNames.length).toBeGreaterThan(0);
    for (const name of shippedPackNames) {
      expect({ pack: name, examples: examplePaths.filter((path) => path.startsWith(`packs/${name}/examples/`)).length > 0 }).toEqual({ pack: name, examples: true });
    }
  });

  test("every shipped pack's example opens as a project's configuration with no problem", async () => {
    expect(examplePaths.length).toBeGreaterThan(0);
    for (const examplePath of examplePaths) {
      const root = projectWithConfig(readFileSync(join(BOUNDED, examplePath), "utf8"));
      const { judge, problem } = await openProject(root, { ports: [...protectedPathsPortProvisions(), ...prereqsPortProvisions()] });
      expect({ example: examplePath, problem }).toEqual({ example: examplePath, problem: null });
      const verdict = await judge({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: "README.md" }] });
      expect({ example: examplePath, verdict: verdict.kind }).toEqual({ example: examplePath, verdict: "allow" });
    }
  });

  test("every example's default export carries a TSDoc title", () => {
    expect(examplePaths.length).toBeGreaterThan(0);
    for (const examplePath of examplePaths) {
      const tsDoc = defaultExportTsDoc(examplePath, readFileSync(join(BOUNDED, examplePath), "utf8"));
      const title = tsDoc?.split("\n")[0]?.trim() ?? "";
      expect({ example: examplePath, hasTitle: title !== "" }).toEqual({ example: examplePath, hasTitle: true });
    }
  });
});

/** The example at `examplePath` (from src/) opened as a project's configuration, in a project that also holds `files`. */
async function opened(examplePath: string, files: Record<string, string> = {}) {
  const root = projectWithConfig(readFileSync(join(BOUNDED, examplePath), "utf8"), files);
  const project = await openProject(root, { ports: [...protectedPathsPortProvisions(), ...prereqsPortProvisions()] });
  expect(project.problem).toBeNull();
  return { root, ...project };
}

/** One tool use writing `path` with `change`, in the core's wire form. */
const write = (path: string, change: "create" | "modify" | "delete") => ({ kind: "tool-use", role: null, tool: "write", effects: [{ kind: "write", path, change }] });
/** One tool use reading `path`. */
const read = (path: string) => ({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path }] });
/** One tool use listing `root`, filtered to `filter` (null: no filter). */
const list = (root: string, filter: string | null) => ({ kind: "tool-use", role: null, tool: "search", effects: [{ kind: "list", root, filter }] });
/** One content search of `root` filtered to `filter`: a list effect and a read effect over the same root, as a host makes for a search. */
const search = (root: string, filter: string) => ({
  kind: "tool-use",
  role: null,
  tool: "search",
  effects: [
    { kind: "list", root, filter },
    { kind: "read", path: root },
  ],
});
/** One tool use delegating to `agent`, with the call id `callId`. */
const delegate = (agent: string, callId: string) => ({ kind: "tool-use", role: null, tool: "subagent", effects: [{ kind: "delegate", agent }], callId });
/** One tool use executing `command` with the call id `callId`, read as running `program` with `args` from the project root. */
const execute = (callId: string, command: string, program: string, ...args: string[]) => ({
  kind: "tool-use",
  role: null,
  tool: "shell",
  effects: [{ kind: "execute", command, cwd: null, reading: readingOf(program, ...args) }],
  callId,
});
/** `agent` reviews in `project`: the delegation (call `callId`) is allowed, and its finished run is recorded with no message. */
async function reviewedBy(project: Awaited<ReturnType<typeof opened>>, agent: string, callId: string): Promise<void> {
  expect((await project.judge(delegate(agent, callId))).kind).toBe("allow");
  const finished = { ...delegate(agent, callId), kind: "tool-result", ok: true, delegatedAgentRuns: [{ finished: true, resolvedAgent: agent }] };
  expect((await project.afterTool(finished)).message).toBeNull();
}
/** The refusal's reason, or "allowed". */
const reasonOf = (verdict: { kind: string; reason?: string }): string => (verdict.kind === "refuse" ? (verdict.reason ?? "") : "allowed");
/** The refusal's redirect, or "allowed". */
const redirectOf = (verdict: { kind: string; redirect?: string }): string => (verdict.kind === "refuse" ? (verdict.redirect ?? "") : "allowed");

describe("every shipped pack's example, its rules exercised", () => {
  test("the examples exercised below are every shipped pack's examples", () => {
    expect(examplePaths).toEqual([
      "packs/prereqs/examples/review-infra-before-apply.config.ts",
      "packs/prereqs/examples/review-plan-before-building.config.ts",
      "packs/prereqs/examples/review-spec-before-tests.config.ts",
      "packs/protected-paths/examples/guard-the-guardrails.config.ts",
      "packs/protected-paths/examples/keep-secrets-out.config.ts",
    ]);
  });

  test("review-plan-before-building: a write under src/ and a delegation to builder are refused, allowed once plan-reviewer succeeds, and refused again when the plan changes; .bounded/ and .claude/agents/ are protected", async () => {
    const project = await opened("packs/prereqs/examples/review-plan-before-building.config.ts", {
      ".agent-state/item/plan.md": "the plan\n",
      "src/a.ts": "export const a = 1;\n",
    });
    const { root, judge } = project;
    const refusedWrite = await judge(write("src/a.ts", "modify"));
    expect(reasonOf(refusedWrite)).toContain("plan-reviewer has not succeeded over them");
    expect(redirectOf(refusedWrite)).toBe("Have plan-reviewer review the current plan before editing src/");
    expect(redirectOf(await judge(delegate("builder", "b1")))).toBe("Have plan-reviewer review the current plan");

    await reviewedBy(project, "plan-reviewer", "r1");
    expect(reasonOf(await judge(write("src/a.ts", "modify")))).toBe("allowed");
    expect(reasonOf(await judge(delegate("builder", "b2")))).toBe("allowed");

    writeFileSync(join(root, ".agent-state", "item", "plan.md"), "the plan, edited\n");
    expect(reasonOf(await judge(write("src/a.ts", "modify")))).toContain("plan-reviewer succeeded over them, but they have changed since");
    expect(reasonOf(await judge(delegate("builder", "b3")))).toContain("plan-reviewer succeeded over them, but they have changed since");

    expect(redirectOf(await judge(write(".bounded/prereqs/records.jsonl", "modify")))).toBe("Leave .bounded/ to Bounded");
    expect(redirectOf(await judge(write(".claude/agents/plan-reviewer.md", "create")))).toBe("Ask a person to change an agent's definition");
  });

  test("review-spec-before-tests: a delegation to test-writer is refused, allowed once spec-reviewer succeeds, and refused again when a contract or the spec changes", async () => {
    const project = await opened("packs/prereqs/examples/review-spec-before-tests.config.ts", {
      "spec.md": "the spec\n",
      "src/a.contract.ts": "export interface A {}\n",
    });
    const { root, judge } = project;
    const refused = await judge(delegate("test-writer", "t1"));
    expect(reasonOf(refused)).toContain("spec-reviewer has not succeeded over them");
    expect(redirectOf(refused)).toBe("Have spec-reviewer review the current spec and contracts");
    expect(reasonOf(await judge(write("src/a.ts", "create")))).toBe("allowed");

    await reviewedBy(project, "spec-reviewer", "r1");
    expect(reasonOf(await judge(delegate("test-writer", "t2")))).toBe("allowed");
    writeFileSync(join(root, "src", "a.contract.ts"), "export interface A { readonly a: number }\n");
    expect(reasonOf(await judge(delegate("test-writer", "t3")))).toContain("spec-reviewer succeeded over them, but they have changed since");

    await reviewedBy(project, "spec-reviewer", "r2");
    expect(reasonOf(await judge(delegate("test-writer", "t4")))).toBe("allowed");
    writeFileSync(join(root, "spec.md"), "the spec, edited\n");
    expect(reasonOf(await judge(delegate("test-writer", "t5")))).toContain("spec-reviewer succeeded over them, but they have changed since");

    expect(redirectOf(await judge(write(".claude/agents/spec-reviewer.md", "modify")))).toBe("Ask a person to change an agent's definition");
  });

  test("review-infra-before-apply: terraform apply is refused, allowed once infra-reviewer succeeds, and refused again when infra/ changes; terraform plan is always allowed", async () => {
    const project = await opened("packs/prereqs/examples/review-infra-before-apply.config.ts", { "infra/main.tf": "terraform {}\n" });
    const { root, judge } = project;
    const apply = (callId: string) => execute(callId, "terraform apply", "terraform", "apply");
    const plan = (callId: string) => execute(callId, "terraform plan", "terraform", "plan");
    const refused = await judge(apply("a1"));
    expect(reasonOf(refused)).toContain("before executing 'terraform apply'");
    expect(reasonOf(refused)).toContain("infra-reviewer has not succeeded over them");
    expect(redirectOf(refused)).toBe("Have infra-reviewer review the current infra/ changes");
    expect(reasonOf(await judge(plan("p1")))).toBe("allowed");

    await reviewedBy(project, "infra-reviewer", "r1");
    expect(reasonOf(await judge(apply("a2")))).toBe("allowed");

    writeFileSync(join(root, "infra", "main.tf"), 'terraform { required_version = ">= 1.0" }\n');
    expect(reasonOf(await judge(apply("a3")))).toContain("infra-reviewer succeeded over them, but they have changed since");
    expect(reasonOf(await judge(plan("p2")))).toBe("allowed");
  });

  test("keep-secrets-out: environment files, private keys and secrets/ are neither read nor written; .env.example and a filtered search that cannot reach secrets/ stay allowed", async () => {
    const { judge } = await opened("packs/protected-paths/examples/keep-secrets-out.config.ts", {
      ".env": "TOKEN=1\n",
      ".env.example": "TOKEN=\n",
      "app/.env": "TOKEN=2\n",
      "certs/server.pem": "-----BEGIN PRIVATE KEY-----\n",
      "secrets/db.txt": "password\n",
      "src/a.ts": "export const a = 1;\n",
    });
    const ENV_REDIRECT = "Ask a maintainer for the value you need; .env.example names every variable";
    expect(redirectOf(await judge(read(".env")))).toBe(ENV_REDIRECT);
    expect(redirectOf(await judge(read("app/.env")))).toBe(ENV_REDIRECT);
    expect(redirectOf(await judge(write(".env.local", "create")))).toBe(ENV_REDIRECT);
    expect(redirectOf(await judge(read("certs/server.pem")))).toBe("Ask a maintainer to run the step that needs the key");
    expect(redirectOf(await judge(read("secrets/db.txt")))).toBe("Ask a maintainer for the value you need");
    expect(redirectOf(await judge(list("secrets", null)))).toBe("List a root outside 'secrets' — Ask a maintainer for the value you need");
    expect(reasonOf(await judge(search(".", "*.ts")))).toContain("the rule 'secrets' from bounded/project");

    expect(reasonOf(await judge(read(".env.example")))).toBe("allowed");
    expect(reasonOf(await judge(read("src/a.ts")))).toBe("allowed");
    expect(reasonOf(await judge(search("src", "*.ts")))).toBe("allowed");
  });

  test("guard-the-guardrails: every path bounded init's defaults protect, generated code and applied migrations are protected; their carve-outs are not", async () => {
    const { judge } = await opened("packs/protected-paths/examples/guard-the-guardrails.config.ts", {
      "generated/api.ts": "export const api = 1;\n",
      "generated/README.md": "Written by the generator.\n",
      "migrations/001.sql": "create table a (id int);\n",
    });
    const refusedWrites: [ReturnType<typeof write>, string][] = [
      [write("bounded.config.ts", "modify"), "Ask a person to change the project's Bounded configuration; describe the change you need"],
      [write("packages/app/bounded.config.mjs", "create"), "Ask a person to change the project's Bounded configuration; describe the change you need"],
      [write(".bounded/log.jsonl", "modify"), "Leave .bounded/ to Bounded; ask a person if its state looks wrong"],
      [write(".claude/settings.json", "modify"), "Ask a person to change Claude Code's settings"],
      [write(".claude/settings.local.json", "create"), "Ask a person to change Claude Code's settings"],
      [write(".pi/extensions/bounded/index.ts", "create"), "Ask a person to change pi's Bounded loader; `npx bounded update` writes it"],
      [write("node_modules/bounded/package.json", "modify"), "Ask a person to install or upgrade Bounded (`npx bounded update`)"],
      [write(".git/hooks/pre-commit", "create"), "Ask a person to add or change git hooks; describe the check you need"],
      [write(".git/config", "modify"), "Ask a person to change git's configuration; describe the setting you need"],
      [write("generated/api.ts", "modify"), "Change the generator's input, then run the generator"],
      [write("migrations/001.sql", "modify"), "Add a new migration instead"],
      [write("migrations/001.sql", "delete"), "Add a new migration instead"],
    ];
    for (const [event, redirect] of refusedWrites) {
      expect({ effect: event.effects[0], redirect: redirectOf(await judge(event)) }).toEqual({ effect: event.effects[0], redirect });
    }
    const allowed = [write("generated/README.md", "modify"), write("migrations/002.sql", "create"), write("src/a.ts", "modify"), write(".pi/extensions/other/index.ts", "create"), read("generated/api.ts")];
    for (const event of allowed) {
      expect({ effect: event.effects[0], verdict: reasonOf(await judge(event)) }).toEqual({ effect: event.effects[0], verdict: "allowed" });
    }
  });
});
