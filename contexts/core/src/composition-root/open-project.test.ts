import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Composition, Verdict } from "bounded/domain";
import { pathGateFileSystem } from "bounded/path-gate/adapters/file-system";
import { openProject } from "./open-project.ts";

const CORE = resolve(import.meta.dir, "../..");
// Snapshots go to the user's state directory: a temporary one here.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "bounded-state-"));
const CONFIG = `import { contribution, corePack, defineConfig, Verdict } from "bounded/domain";
export default defineConfig({
  packs: [corePack],
  contributes: [contribution(corePack.points.effectGuards.write, [(effect) => (effect.path.value.startsWith("generated/") ? Verdict.refuse("Generated", "Change the generator's input") : Verdict.allow)])],
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

  test("never rejects: a bound that cannot be used gives a judge that refuses everything", async () => {
    const root = project({ "bounded.config.ts": CONFIG });
    const { judge, problem } = await openProject(root, { recordWithinMs: 0 });
    expect(problem).toBe("recordWithinMs must be a finite number of milliseconds above zero");
    expect((await judge({ kind: "session-start", role: null })).kind).toBe("refuse");
  });

  test("never rejects: a configuration source that returns no result gives a judge that refuses everything, and records it", async () => {
    const root = project({});
    const { judge, problem } = await openProject(root, { configSource: { load: async () => null as never } });
    expect(problem).toBe("the configuration source returned no result");
    expect((await judge({ kind: "session-start", role: null })).kind).toBe("refuse");
    expect(log(root).map((line) => line.verdict.kind)).toEqual(["refuse"]);
  });

  test("a configuration cannot patch the core: Verdict and Composition stay as they are", async () => {
    const tampering = `import { Composition, contribution, corePack, defineConfig, Verdict } from "bounded/domain";
let patched = "no";
try { (Verdict as unknown as { parse: unknown }).parse = () => ({ ok: true, value: { kind: "allow" } }); patched = "yes"; } catch { patched = "refused"; }
try { (Composition as unknown as { compose: unknown }).compose = () => ({ ok: false, error: "patched" }); } catch {}
export const attempt = patched;
export default defineConfig({
  packs: [corePack],
  contributes: [contribution(corePack.points.effectGuards.write, [() => Verdict.refuse("No writes", "Ask")])],
});
`;
    const root = project({ "bounded.config.ts": tampering });
    const { judge, problem } = await openProject(root);
    expect(problem).toBeNull();
    const verdict = await judge({ kind: "tool-use", role: null, tool: "edit", effects: [{ kind: "write", path: "a.ts", change: "modify" }] });
    expect(verdict.kind).toBe("refuse");
    expect(Verdict.parse({ kind: "bogus" }).ok).toBe(false);
    expect(Composition.compose([], []).ok).toBe(true);
  });

  test("a shell command that changes a watched file is undone after it runs, reported and recorded", async () => {
    const watching = `import { contribution, corePack, defineConfig } from "bounded/domain";
import { pathGate } from "bounded/path-gate";
export default defineConfig({
  packs: [corePack, pathGate],
  contributes: [contribution(pathGate.points.protectedPaths, [{ match: "generated/**", deny: ["create", "modify", "delete"], why: "generated/ is written by the generator", redirect: "Change the generator's input instead" }])],
});
`;
    const root = project({ "bounded.config.ts": watching });
    mkdirSync(join(root, "generated"));
    writeFileSync(join(root, "generated", "a.ts"), "original\n");
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: root });
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.bounded/\n");
    git("init", "--quiet");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");
    const { judge, afterTool } = await openProject(root, { ports: pathGateFileSystem() });
    const shell = { kind: "tool-use", role: "builder", tool: "shell", effects: [{ kind: "execute", command: "./regenerate.sh" }], callId: "toolu_1" };
    expect((await judge(shell)).kind).toBe("allow");
    writeFileSync(join(root, "generated", "a.ts"), "tampered\n");
    writeFileSync(join(root, "generated", "new.ts"), "created\n");
    const check = await afterTool({ ...shell, kind: "tool-result", ok: true });
    const where = /What it created was moved, not deleted, to (.+)\.$/.exec(check.message ?? "")?.[1] ?? "";
    expect(check.message).toBe(
      `This command changed protected files, and they were restored: generated/a.ts was modified, generated/new.ts was created — protected because generated/ is written by the generator. Change the generator's input instead. What it created was moved, not deleted, to ${where}.`,
    );
    expect(where.startsWith(join(process.env.XDG_STATE_HOME ?? "", "bounded"))).toBe(true);
    expect(readFileSync(join(where, "generated", "new.ts"), "utf8")).toBe("created\n");
    expect(readFileSync(join(root, "generated", "a.ts"), "utf8")).toBe("original\n");
    expect(existsSync(join(root, "generated", "new.ts"))).toBe(false);
    const lines = log(root);
    expect(lines.map((line) => line.event)).toEqual(["tool-use", "tool-result"]);
    expect(lines[1]?.verdict.kind).toBe("refuse");
  });

  describe("a file whose name holds a control character, such as a newline, is still watched", () => {
    const WEIRD = "we\nird.ts";
    async function watched(files: Record<string, string>) {
      const config = `import { contribution, corePack, defineConfig } from "bounded/domain";
import { pathGate } from "bounded/path-gate";
export default defineConfig({
  packs: [corePack, pathGate],
  contributes: [contribution(pathGate.points.protectedPaths, [{ match: "generated/*.ts", deny: ["create", "modify", "delete"], why: "generated/ is written by the generator", redirect: "Change the generator's input instead" }])],
});
`;
      const root = project({ "bounded.config.ts": config });
      mkdirSync(join(root, "generated"));
      for (const [name, text] of Object.entries(files)) writeFileSync(join(root, "generated", name), text);
      writeFileSync(join(root, ".gitignore"), "node_modules/\n.bounded/\n");
      const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: root });
      git("init", "--quiet");
      git("add", "-A");
      git("commit", "--quiet", "-m", "base");
      const opened = await openProject(root, { ports: pathGateFileSystem() });
      const shell = { kind: "tool-use", role: "builder", tool: "shell", effects: [{ kind: "execute", command: "./regenerate.sh" }], callId: "toolu_weird" };
      expect((await opened.judge(shell)).kind).toBe("allow");
      return { root, after: () => opened.afterTool({ ...shell, kind: "tool-result", ok: true }) };
    }

    test("one a command creates is moved aside and reported by an escaped name", async () => {
      const { root, after } = await watched({ "a.ts": "a" });
      writeFileSync(join(root, "generated", WEIRD), "created\n");
      const check = await after();
      expect(check.message).toContain("This command changed protected files, and they were restored");
      expect(check.message).toContain("generated/we\\nird.ts was created");
      expect(check.message).not.toContain("\n");
      expect(existsSync(join(root, "generated", WEIRD))).toBe(false);
      const where = /moved, not deleted, to (.+)\.$/.exec(check.message ?? "")?.[1] ?? "";
      expect(readFileSync(join(where, "generated", WEIRD), "utf8")).toBe("created\n");
    });

    test("one that existed before and a command modifies is restored", async () => {
      const { root, after } = await watched({ [WEIRD]: "original\n" });
      writeFileSync(join(root, "generated", WEIRD), "tampered\n");
      const check = await after();
      expect(check.message).toContain("This command changed protected files, and they were restored");
      expect(check.message).toContain("generated/we\\nird.ts was modified");
      expect(readFileSync(join(root, "generated", WEIRD), "utf8")).toBe("original\n");
    });
  });

  test("openProject prepares the path gate's shell check: reads by absolute path, and redirects judged by whether the file exists", async () => {
    const config = `import { corePack, defineConfig, contribution } from "bounded/domain";
import { pathGate } from "bounded/path-gate";
export default defineConfig({
  packs: [corePack, pathGate],
  contributes: [
    contribution(pathGate.points.protectedPaths, [
      { match: ".env", file: true, deny: ["read"], redirect: "Ask a maintainer for the value" },
      { match: "migrations/**", deny: ["modify", "delete"], redirect: "Add a new migration instead" },
    ]),
  ],
});
`;
    const root = realpathSync(project({ "bounded.config.ts": config }));
    mkdirSync(join(root, "migrations"));
    writeFileSync(join(root, "migrations", "0001_init.sql"), "create table a;");
    writeFileSync(join(root, ".env"), "KEY=1");
    const { judge, problem } = await openProject(root, { ports: pathGateFileSystem() });
    expect(problem).toBeNull();
    let calls = 0;
    const shell = (command: string) => judge({ kind: "tool-use", role: null, tool: "shell", effects: [{ kind: "execute", command, cwd: null }], callId: `call-${++calls}` });
    expect(await shell(`cat ${join(root, ".env")}`)).toMatchObject({ kind: "refuse", redirect: "Ask a maintainer for the value" });
    expect((await shell("cat /etc/hosts")).kind).toBe("allow");
    expect((await shell("echo 'create table b;' > migrations/0002_add.sql")).kind).toBe("allow");
    expect(await shell("echo 'drop table a;' >> migrations/0001_init.sql")).toMatchObject({ kind: "refuse", redirect: "Add a new migration instead" });
  });

  test("a root that is not an absolute path gives a judge that refuses everything", async () => {
    const { judge, problem } = await openProject("relative/root");
    expect(problem).toBe("A project root is an absolute directory path, such as /home/me/project");
    expect((await judge({ kind: "session-start", role: null })).kind).toBe("refuse");
  });
});
