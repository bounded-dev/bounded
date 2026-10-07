import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Composition, Verdict } from "bounded/domain";
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
  contributes: [contribution(corePack.points.writeGuards, [() => Verdict.refuse("No writes", "Ask")])],
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
export default defineConfig({
  packs: [corePack],
  contributes: [contribution(corePack.points.watchedPaths, [{ match: "generated/**", why: "generated/ is written by the generator", redirect: "Change the generator's input instead" }])],
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
    const { judge, afterTool } = await openProject(root);
    const shell = { kind: "tool-use", role: "builder", tool: "shell", effects: [{ kind: "execute", command: "./regenerate.sh" }], callId: "toolu_1" };
    expect((await judge(shell)).kind).toBe("allow");
    writeFileSync(join(root, "generated", "a.ts"), "tampered\n");
    writeFileSync(join(root, "generated", "new.ts"), "created\n");
    const check = await afterTool({ ...shell, kind: "tool-result", ok: true });
    expect(check.message).toBe(
      "This command changed protected files, and they were restored: generated/a.ts was modified, generated/new.ts was created. generated/ is written by the generator. Instead: Change the generator's input instead.",
    );
    expect(readFileSync(join(root, "generated", "a.ts"), "utf8")).toBe("original\n");
    expect(existsSync(join(root, "generated", "new.ts"))).toBe(false);
    const lines = log(root);
    expect(lines.map((line) => line.event)).toEqual(["tool-use", "tool-result"]);
    expect(lines[1]?.verdict.kind).toBe("refuse");
  });

  test("a root that is not an absolute path gives a judge that refuses everything", async () => {
    const { judge, problem } = await openProject("relative/root");
    expect(problem).toBe("A project root is an absolute directory path, such as /home/me/project");
    expect((await judge({ kind: "session-start", role: null })).kind).toBe("refuse");
  });
});
