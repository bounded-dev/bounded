import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openProject } from "./open-project.ts";

const CORE = resolve(import.meta.dir, "../..");
const CONFIG = `import { contribution, corePack, defineConfig, Verdict } from "bounded/domain";
export default defineConfig({
  packs: [corePack],
  contributes: [contribution(corePack.points.writeGuards, [(effect) => (effect.path.startsWith("generated/") ? Verdict.refuse("Generated", "Change the generator's input") : Verdict.allow)])],
});
`;

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "bounded-project-"));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(CORE, join(root, "node_modules", "bounded"), "dir");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

const log = (root: string): { event: string; verdict: { kind: string } }[] =>
  readFileSync(join(root, ".bounded", "guard-log.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));

describe("openProject — what a host's composition root calls", () => {
  test("judges events with the project's bounded.config.ts and records them in .bounded/guard-log.jsonl", async () => {
    const root = project({ "bounded.config.ts": CONFIG });
    const { judge, problem } = await openProject(root);
    expect(problem).toBeNull();
    const refused = await judge({ kind: "tool-use", role: "builder", tool: "edit", effects: [{ kind: "write", path: "generated/a.ts", change: "modify" }] });
    expect<unknown>(refused).toEqual({ kind: "refuse", reason: "bounded/project refused write (modify) generated/a.ts: Generated", redirect: "Change the generator's input" });
    expect((await judge({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: "a.ts" }] })).kind).toBe("allow");
    expect(log(root).map((line) => line.verdict.kind)).toEqual(["refuse", "allow"]);
  });

  test("an event that cannot be read is refused and recorded", async () => {
    const root = project({ "bounded.config.ts": CONFIG });
    const { judge } = await openProject(root);
    expect((await judge("not an event")).kind).toBe("refuse");
    expect(log(root).map((line) => line.event)).toEqual(["invalid"]);
  });

  test("a project with a broken configuration refuses every event and records why", async () => {
    const root = project({ "bounded.config.ts": "export default 42;\n" });
    const { judge, problem } = await openProject(root);
    expect(problem).toBe("bounded.config.ts must export default defineConfig({ packs: [...] }); its default export is a number");
    const verdict = await judge({ kind: "session-start", role: null });
    expect(verdict.kind === "refuse" && verdict.reason).toBe(`This project's configuration cannot be used: ${problem}`);
    expect(log(root).map((line) => line.verdict.kind)).toEqual(["refuse"]);
  });

  test("a root that is not an absolute path gives a judge that refuses everything", async () => {
    const { judge, problem } = await openProject("relative/root");
    expect(problem).toBe("A project root is an absolute directory path, such as /home/me/project");
    expect((await judge({ kind: "session-start", role: null })).kind).toBe("refuse");
  });
});
