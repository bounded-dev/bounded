// bounded-shell-command-reader/application: reading shell commands for host
// adapters (ADR 2026-020). Contracts are exported as types. Commands are
// exported from their implementation file (type and value together).
export type { ReadShellCommand, ReadShellCommandCommandFactory, ReadShellCommandInput, ReadShellCommandOptions, ShellCommandReader } from "./shell-commands/read-shell-command/read-shell-command.contract.ts";
export { ReadShellCommandCommand } from "./shell-commands/read-shell-command/read-shell-command.command.ts";
export { ReadShellCommandHandler } from "./shell-commands/read-shell-command/read-shell-command.handler.ts";

// Everything exported here is frozen, a function's or class's prototype too,
// so code loaded later (a project's configuration, a pack) cannot patch it.
import * as exported from "./index.ts";
for (const value of Object.values(exported)) {
  Object.freeze(value);
  if (typeof value === "function" && value.prototype !== undefined) Object.freeze(value.prototype);
}
