#!/usr/bin/env bun
import packageManifest from "./package.json";
import * as domain from "bounded/domain";
import * as application from "bounded/application";
import * as adapters from "bounded/adapters";
import * as project from "bounded/open-project";
import * as prereqs from "bounded/prereqs";
import * as prereqsAdapters from "bounded/prereqs/adapters";
import * as protectedPaths from "bounded/protected-paths";
import * as protectedPathsAdapters from "bounded/protected-paths/adapters";
import * as shellCommandReader from "bounded/shell-command-reader";
import { join } from "node:path";
import { buildStandaloneConfigModule } from "./hosts/claude-code/standalone-config-as-module.ts";

function embeddedWasmPath(name: "tree-sitter" | "tree-sitter-bash"): string {
  const pattern = name === "tree-sitter" ? /^tree-sitter-[a-z0-9]+\.wasm$/ : /^tree-sitter-bash-[a-z0-9]+\.wasm$/;
  const file = Bun.embeddedFiles.find((candidate) => pattern.test(Reflect.get(candidate, "name")));
  const filename: unknown = file === undefined ? undefined : Reflect.get(file, "name");
  if (typeof filename !== "string") throw new Error(`the standalone executable does not contain ${name}.wasm`);
  return join(import.meta.dir, filename);
}

Object.defineProperty(globalThis, "__boundedStandaloneWasmPaths", {
  value: Object.freeze({ engine: embeddedWasmPath("tree-sitter"), grammar: embeddedWasmPath("tree-sitter-bash") }),
  configurable: false,
  writable: false,
});

Object.defineProperty(globalThis, "__boundedStandaloneConfigLoader", {
  value: buildStandaloneConfigModule,
  configurable: false,
  writable: false,
});

// Configs and local packs must use the executable's own core and shipped pack
// objects. Runtime-built modules read these exact objects through virtual
// modules, so their nominal brands and pack dependency identity remain valid.
Object.defineProperty(globalThis, "__boundedStandaloneRuntimeExports", {
  value: Object.freeze({
    "bounded/domain": domain,
    "bounded/application": application,
    "bounded/adapters": adapters,
    "bounded/open-project": project,
    "bounded/prereqs": prereqs,
    "bounded/prereqs/adapters": prereqsAdapters,
    "bounded/protected-paths": protectedPaths,
    "bounded/protected-paths/adapters": protectedPathsAdapters,
    "bounded/shell-command-reader": shellCommandReader,
  }),
  configurable: false,
  writable: false,
});

const [command, host, ...rest] = process.argv.slice(2);
if (command === "--version" && host === undefined) {
  process.stdout.write(`${packageManifest.version}\n`);
} else if (command === "hook" && host === "claude-code" && rest.length === 0) {
  // The host entry owns the fail-closed wire response, including bootstrap failures.
  await import("./hosts/claude-code/main.ts");
} else {
  const { runBoundedCli } = await import("./cli/bounded-cli.ts");
  const result = await runBoundedCli(process.argv.slice(2), process.cwd());
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
