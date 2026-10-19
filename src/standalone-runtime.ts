import * as domain from "bounded/domain";
import * as application from "bounded/application";
import * as adapters from "bounded/adapters";
import * as project from "bounded/open-project";
import * as prereqs from "bounded/prereqs";
import * as prereqsAdapters from "bounded/prereqs/adapters";
import * as protectedPaths from "bounded/protected-paths";
import * as protectedPathsAdapters from "bounded/protected-paths/adapters";
import { shellCommandReader } from "./cli/standalone-shell-command-reader.ts";
import { join } from "node:path";
import { buildStandaloneConfigModule } from "./hosts/claude-code/standalone-config-as-module.ts";

function embeddedWasmPath(name: "tree-sitter" | "tree-sitter-bash"): string {
  const pattern = name === "tree-sitter" ? /^tree-sitter-[a-z0-9]+\.wasm$/ : /^tree-sitter-bash-[a-z0-9]+\.wasm$/;
  const file = Bun.embeddedFiles.find((candidate) => pattern.test(Reflect.get(candidate, "name")));
  const filename: unknown = file === undefined ? undefined : Reflect.get(file, "name");
  if (typeof filename !== "string") throw new Error(`the standalone executable does not contain ${name}.wasm`);
  return join(import.meta.dir, filename);
}

function prepareStandaloneRuntime(): void {
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
  // Runtime-built configs and local packs use these exact module objects, so
  // nominal brands and pack dependencies match the executable's own core.
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
}

export async function runStandaloneRuntime(args: readonly string[], hostProjectRoot?: string): Promise<void> {
  prepareStandaloneRuntime();
  const [command, host] = args;
  if (command === "hook" && host === "claude-code") {
    if (hostProjectRoot !== undefined) process.env.CLAUDE_PROJECT_DIR = hostProjectRoot;
    // The host entry owns the fail-closed wire response, including bootstrap failures.
    await import("./hosts/claude-code/main.ts");
  } else {
    const { runBoundedCli } = await import("./cli/bounded-cli.ts");
    const result = await runBoundedCli(args, process.cwd());
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  }
}
