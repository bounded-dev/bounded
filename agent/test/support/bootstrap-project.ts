// Test support: the files the Claude Code bootstrap entry needs, and
// project states shared by the pi and Claude Code bootstrap tests.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Harness-relative files the bootstrap entry loads before setup. */
export const BOOTSTRAP_RUNTIME = [
  "hosts/claude-code/bootstrap-hook.ts",
  "hosts/claude-code/project-read.ts",
  "src/setup-state.ts",
  "src/guard-log.ts",
  "src/is-main-module.ts",
  "src/pack-contrib.ts",
  "src/project-composition.ts",
] as const;

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Compose one data-only pack whose setup contribution names a probe path. */
export function composeDemoPack(project: string): void {
  put(join(project, ".bounded", "installation.json"), "{}\n");
  put(join(project, ".bounded", "composed-packs.json"), '["demo"]\n');
  put(join(project, ".bounded", "harness", "packs", "demo", "contrib.json"),
    JSON.stringify({ projectSetupCommands: [["demo-install"]], projectSetupProbes: ["deps/ready"] }));
}

/** Record a completed setup and create every probe it promises. */
export function markDependenciesReady(project: string): void {
  composeDemoPack(project);
  put(join(project, "deps", "ready"), "");
  put(join(project, ".bounded", "harness", "node_modules", ".package-lock.json"), "{}\n");
  put(join(project, ".bounded", "setup-complete"), "complete\n");
}
