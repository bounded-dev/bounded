import { describe, expect, test } from "bun:test";
import type { HostInstaller, HostInstallerSource, ProjectSetupFiles } from "./update-project.contract.ts";
import { UpdateProjectHandler } from "./update-project.handler.ts";

const ROOT = "/project";

/** Project files whose configuration names are `present`; creating a configuration is a failure of the test. */
function memoryFiles(present: readonly string[]): ProjectSetupFiles {
  return {
    configFileNames: async () => ({ ok: true, value: [...present] }),
    createConfig: async () => {
      throw new Error("update never writes a configuration");
    },
  };
}

/** An installer that changes `host`.json the first time and nothing after: idempotent, as every installer must be. */
function installer(host: string): HostInstaller & { runs: number } {
  const state = { runs: 0 };
  return Object.assign(state, {
    host,
    install: async () => {
      state.runs += 1;
      return { ok: true as const, value: { host, changedPaths: state.runs === 1 ? [`${host}.json`] : [], skippedBecause: null } };
    },
  });
}

const source = (...installers: HostInstaller[]): HostInstallerSource => ({ load: async () => ({ ok: true, value: installers }) });

describe("UpdateProjectHandler: bounded update (the hooks refresh)", () => {
  test("runs every host installer and never writes the configuration", async () => {
    const claude = installer("claude-code");
    const done = await new UpdateProjectHandler(memoryFiles(["bounded.config.ts"]), source(claude)).execute(ROOT);
    expect(done).toEqual({ ok: true, value: { configWritten: null, hosts: [{ host: "claude-code", changedPaths: ["claude-code.json"], skippedBecause: null }] } });
  });

  test("is idempotent: run twice, the second changes nothing", async () => {
    const handler = new UpdateProjectHandler(memoryFiles(["bounded.config.mjs"]), source(installer("claude-code")));
    await handler.execute(ROOT);
    expect(await handler.execute(ROOT)).toEqual({ ok: true, value: { configWritten: null, hosts: [{ host: "claude-code", changedPaths: [], skippedBecause: null }] } });
  });

  test("refuses a project that was never initialised, saying to run bounded init", async () => {
    const claude = installer("claude-code");
    const done = await new UpdateProjectHandler(memoryFiles([]), source(claude)).execute(ROOT);
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error).toContain("bounded init");
    expect(claude.runs).toBe(0);
  });

  test("refuses a project with more than one configuration, naming them", async () => {
    const done = await new UpdateProjectHandler(memoryFiles(["bounded.config.ts", "bounded.config.js"]), source(installer("claude-code"))).execute(ROOT);
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error).toContain("bounded.config.ts, bounded.config.js");
  });

  test("refuses when no installed package offers a host installer", async () => {
    const done = await new UpdateProjectHandler(memoryFiles(["bounded.config.ts"]), source()).execute(ROOT);
    expect(done.ok).toBe(false);
  });
});
