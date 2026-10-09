// End to end: a host opens a project with the protected-paths pack's ports and bounded's
// shell command reader, as the hosts bounded carries do (ADR 2026-020).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openProject } from "bounded/open-project";
import { protectedPathsPortProvisions } from "bounded/protected-paths/adapters";
import { TreeSitterShellCommandReader } from "bounded-shell-command-reader/adapters";

const CORE = resolve(import.meta.dir, "../../..");
// Snapshots go to the user's state directory: a temporary one here.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "bounded-state-"));

/** A project holding `files`, resolving bounded as an installed project would: from its node_modules. */
function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-project-")));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(CORE, join(root, "node_modules", "bounded"), "dir");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

describe("openProject with bounded's shell command reader", () => {
  test("openProject, given a shell command reader, reads each command before the protected-paths pack judges it: reads by absolute path, and redirects judged by whether the file exists", async () => {
    const config = `import { corePack, defineConfig, contribution } from "bounded/domain";
import { protectedPathsPack } from "bounded/protected-paths";
export default defineConfig({
  packs: [corePack, protectedPathsPack],
  contributes: [
    contribution(protectedPathsPack.points.protectedPaths, [
      { match: ".env", file: true, deny: ["read"], redirect: "Ask a maintainer for the value" },
      { match: "migrations/**", deny: ["modify", "delete"], redirect: "Add a new migration instead" },
    ]),
  ],
});
`;
    const root = project({ "bounded.config.ts": config });
    mkdirSync(join(root, "migrations"));
    writeFileSync(join(root, "migrations", "0001_init.sql"), "create table a;");
    writeFileSync(join(root, ".env"), "KEY=1");
    const { judge, problem } = await openProject(root, { ports: protectedPathsPortProvisions(), shellCommandReader: new TreeSitterShellCommandReader() });
    expect(problem).toBeNull();
    let calls = 0;
    const shell = (command: string) => judge({ kind: "tool-use", role: null, tool: "shell", effects: [{ kind: "execute", command, cwd: null }], callId: `call-${++calls}` });
    expect(await shell(`cat ${join(root, ".env")}`)).toMatchObject({ kind: "refuse", redirect: "Ask a maintainer for the value" });
    expect((await shell("cat /etc/hosts")).kind).toBe("allow");
    expect((await shell("echo 'create table b;' > migrations/0002_add.sql")).kind).toBe("allow");
    expect(await shell("echo 'drop table a;' >> migrations/0001_init.sql")).toMatchObject({ kind: "refuse", redirect: "Add a new migration instead" });
  });

  test("a project's own execute guard sees the programs bounded read", async () => {
    const config = `import { contribution, corePack, defineConfig, Verdict } from "bounded/domain";
export default defineConfig({
  packs: [corePack],
  contributes: [
    contribution(corePack.points.effectGuards.execute, [
      (effect) =>
        effect.reading?.outcome === "read" && effect.reading.programs.map((program) => program.name.text).join(",") === "tool-a"
          ? Verdict.allow
          : Verdict.refuse("Only tool-a runs here", "Run tool-a"),
    ]),
  ],
});
`;
    const root = project({ "bounded.config.ts": config });
    const { judge, problem } = await openProject(root, { shellCommandReader: new TreeSitterShellCommandReader() });
    expect(problem).toBeNull();
    const shell = (command: string, callId: string) => judge({ kind: "tool-use", role: null, tool: "shell", effects: [{ kind: "execute", command }], callId });
    expect((await shell("tool-a x", "call-1")).kind).toBe("allow");
    expect(await shell("tool-b x", "call-2")).toMatchObject({ kind: "refuse", reason: "bounded/project refused execute `tool-b x`: Only tool-a runs here" });
  });
});
