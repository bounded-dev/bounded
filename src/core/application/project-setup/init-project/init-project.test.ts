import { describe, expect, test } from "bun:test";
import type { Result } from "bounded/domain";
import type { HostInstaller, HostInstallerSource, HostInstallReport, ProjectSetupFiles } from "./init-project.contract.ts";
import { InitProjectHandler } from "./init-project.handler.ts";

/** The configuration the caller gives the handler to write: the content is the caller's (the CLI's), the core only writes it. */
const CONFIG = "export default 1;\n";

const ROOT = "/project";

/** Project files held in memory: the configuration names present, and what createConfig wrote. */
function memoryFiles(present: readonly string[] = []): ProjectSetupFiles & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    configFileNames: async () => ({ ok: true, value: [...present] }),
    createConfig: async (_root, content) => {
      if (present.includes("bounded.config.ts")) return { ok: false, error: "bounded.config.ts exists" };
      written.push(content);
      return { ok: true, value: "bounded.config.ts" };
    },
  };
}

function installer(host: string, answer: Result<HostInstallReport> = { ok: true, value: { host, changedPaths: [`${host}.json`], skippedBecause: null } }): HostInstaller & { runs: string[] } {
  const runs: string[] = [];
  return {
    host,
    runs,
    install: async (root) => {
      runs.push(root);
      return answer;
    },
  };
}

const source = (...installers: HostInstaller[]): HostInstallerSource => ({ load: async () => ({ ok: true, value: installers }) });

describe("InitProjectHandler: bounded init", () => {
  test("in a fresh project, writes the configuration it is given, then runs every host installer", async () => {
    const files = memoryFiles();
    const claude = installer("claude-code");
    const pi = installer("pi", { ok: true, value: { host: "pi", changedPaths: [], skippedBecause: "the project has no .pi/ directory" } });
    const done = await new InitProjectHandler(files, source(claude, pi), CONFIG).execute(ROOT);
    expect(done).toEqual({
      ok: true,
      value: {
        configWritten: "bounded.config.ts",
        hosts: [
          { host: "claude-code", changedPaths: ["claude-code.json"], skippedBecause: null },
          { host: "pi", changedPaths: [], skippedBecause: "the project has no .pi/ directory" },
        ],
      },
    });
    expect(files.written).toEqual([CONFIG]);
    expect(claude.runs).toEqual([ROOT]);
  });

  test("refuses a project that already has a configuration, writing and installing nothing", async () => {
    for (const present of [["bounded.config.ts"], ["bounded.config.mjs"], ["bounded.config.js", "bounded.config.ts"]]) {
      const files = memoryFiles(present);
      const claude = installer("claude-code");
      const done = await new InitProjectHandler(files, source(claude), CONFIG).execute(ROOT);
      expect(done.ok).toBe(false);
      if (!done.ok) expect(done.error).toContain("bounded update");
      expect(files.written).toEqual([]);
      expect(claude.runs).toEqual([]);
    }
  });

  test("refuses when no installed package offers a host installer, writing nothing", async () => {
    const files = memoryFiles();
    const done = await new InitProjectHandler(files, source(), CONFIG).execute(ROOT);
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error).toContain("host adapter");
    expect(files.written).toEqual([]);
  });

  test("refuses when the installers cannot be loaded, writing nothing", async () => {
    const files = memoryFiles();
    const done = await new InitProjectHandler(files, { load: async () => ({ ok: false, error: "no package.json" }) }, CONFIG).execute(ROOT);
    expect(done).toEqual({ ok: false, error: "no package.json" });
    expect(files.written).toEqual([]);
  });

  test("a host installer that fails is a refusal naming the host", async () => {
    const done = await new InitProjectHandler(memoryFiles(), source(installer("claude-code", { ok: false, error: "settings.json is not JSON" })), CONFIG).execute(ROOT);
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error).toContain("claude-code: settings.json is not JSON");
  });
});
