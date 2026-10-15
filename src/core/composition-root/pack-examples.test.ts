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
const list = (root: string, filter: string | null) => ({ kind: "tool-use", role: null, tool: "list", effects: [{ kind: "list", root, filter }] });
/** One content search of `root` filtered to `filter`: a list effect and a read effect over the same root, as a host makes for a search. */
const search = (root: string, filter: string) => ({
  kind: "tool-use",
  role: null,
  tool: "grep",
  effects: [
    { kind: "list", root, filter },
    { kind: "read", path: root },
  ],
});
/** One tool use delegating to `agent`, with the call id `callId`. */
const delegate = (agent: string, callId: string) => ({ kind: "tool-use", role: null, tool: "subagent", effects: [{ kind: "delegate", agent }], callId });
/** One tool use executing `command`, read as running `program` with `args` from the project root. */
const execute = (command: string, program: string, ...args: string[]) => ({
  kind: "tool-use",
  role: null,
  tool: "bash",
  effects: [{ kind: "execute", command, cwd: null, reading: readingOf(program, ...args) }],
});
/** The refusal's reason, or "allowed". */
const reasonOf = (verdict: { kind: string; reason?: string }): string => (verdict.kind === "refuse" ? (verdict.reason ?? "") : "allowed");
/** The refusal's redirect, or "allowed". */
const redirectOf = (verdict: { kind: string; redirect?: string }): string => (verdict.kind === "refuse" ? (verdict.redirect ?? "") : "allowed");

describe("every shipped pack's example, its rules exercised", () => {
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
