#!/usr/bin/env bun
import packageManifest from "./package.json";

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
