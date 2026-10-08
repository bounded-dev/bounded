import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyInit, planInit } from "../../src/project-init.ts";

const AGENT = resolve(import.meta.dirname, "..", "..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pi project-local adapter integration", () => {
  test("pi discovers the generated adapter and project roles with a clean global config", async () => {
    const root = mkdtempSync(join(tmpdir(), "bounded-pi-integration-"));
    roots.push(root);
    const project = join(root, "product");
    const cleanAgentDir = join(root, "empty-pi-agent");
    mkdirSync(project);
    mkdirSync(cleanAgentDir);

    const plan = await planInit(project, "pi", ["ts-web"]);
    await applyInit(project, "pi", ["ts-web"], plan.digest);

    // The generated project declares its dependencies. Link the already
    // installed test dependencies only in this disposable fixture so pi's
    // real TS loader can import the copied harness without a network install.
    symlinkSync(join(AGENT, "node_modules"), join(project, ".bounded", "harness", "node_modules"), "dir");

    const loaderPath = join(AGENT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "loader.js");
    const loader = (await import(loaderPath)) as {
      discoverAndLoadExtensions: (paths: string[], cwd: string, agentDir: string) => Promise<{
        extensions: readonly { path?: string }[];
        errors: readonly unknown[];
      }>;
    };
    const loaded = await loader.discoverAndLoadExtensions([], project, cleanAgentDir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions.map((extension) => extension.path)).toEqual([
      join(project, ".pi", "extensions", "bounded", "index.ts"),
    ]);

    // pi-subagents' project-role discovery is supplied by the installed pi
    // package; its example implementation exercises the same discovery API.
    const agentsPath = join(AGENT, "node_modules", "@earendil-works", "pi-coding-agent", "examples", "extensions", "subagent", "agents.ts");
    const { discoverAgents } = (await import(agentsPath)) as {
      discoverAgents: (cwd: string, scope: "project") => { agents: readonly { name: string; source: string }[] };
    };
    const roles = discoverAgents(project, "project").agents;
    expect(roles.map((role) => role.name)).toEqual(expect.arrayContaining(["architect", "builder", "test-writer", "reviewer"]));
    expect(roles.find((role) => role.name === "reviewer")?.source).toBe("project");
    expect(roles.every((role) => role.source === "project")).toBe(true);
  });
});
