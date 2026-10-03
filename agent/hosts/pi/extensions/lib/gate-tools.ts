/**
 * Gate tools — the pi face of the gate registry (ADR 2026-034).
 *
 * A gate's name, description, flags and prompt guidance live in one registry
 * entry (`packs/<lang>/gates.ts`), and `bounded gates` reads that entry for its
 * command line. This module reads the SAME entry for a pi tool, so a gate
 * cannot differ by how it was invoked: the extensions used to hand-wire each
 * tool over the same run function, and hand-wiring is where a description, a
 * parameter or the trailing verdict line drifts between the two hosts.
 *
 * Two mappings, both pure, both exported so a test can pin them without a pi:
 *
 *   · `toolParams(gate)` — the tool's TypeBox schema from the gate's flags. A
 *     `cliOnly` flag is not a parameter (a model passes findings inline, never
 *     by file; a role never chooses its own scoping); a `json` flag exposes
 *     the JSON Schema the registry carries; every tool takes the optional
 *     `cwd` the CLI takes as its positional.
 *   · `gateArgsFrom(gate, params)` — the inverse: the tool's parameters as the
 *     `GateArgs` the gate's `run` reads, keyed by FLAG name (`--pattern`),
 *     which is how the CLI's parser would have keyed them.
 *   · `hostArgs(gate, sessionCwd)` — what the HOST supplies and a caller never
 *     may: a gate with a `cliOnly` `role` flag is handed the session's own
 *     role (the one the path gate acts on), resolved from the SESSION cwd, not
 *     the target `cwd` a caller passed. Run 15's hole was exactly that
 *     resolution done against the target: `typecheck({cwd: "src"})` found no
 *     role file under `src/` and answered unscoped.
 *
 * `registerGateTools` then registers one tool per registry entry in the set a
 * host names. Its output is the CLI's: the gate's lines, then
 * `<gate>: PASS|BLOCK|ERROR` from src/gate-result.ts.
 *
 * This file lives in `extensions/lib/` because pi auto-loads only the
 * top-level `hosts/pi/extensions/*.ts`; a subdirectory is plain code, never an
 * extension (`hosts/pi/extensions/path-gate/` is the standing proof — its per-role
 * loaders are reached only by frontmatter, never auto-loaded).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TObject, type TOptional, type TSchema, type TString } from "typebox";
import type { FlagSpec, GateArgs, GateCommand } from "../../../../src/gate-command.ts";
import { verdictLine } from "../../../../src/gate-result.ts";
import { sessionRole } from "../../../../src/path-gate.ts";
import { targetCwd } from "../../../../src/target-cwd.ts";
import { runGateWithBoard } from "../../../../src/board-sync.ts";
import { openTracker } from "../../../../trackers/index.ts";

/** The one parameter every gate tool takes, worded once. */
export const CWD_DESCRIPTION =
  "Project directory to run in (absolute, or relative to the session cwd). Defaults to the session cwd.";

/** The optional `cwd` parameter, for the gate tools and the host utilities alike. */
export function cwdParam(): TOptional<TString> {
  return Type.Optional(Type.String({ description: CWD_DESCRIPTION }));
}

/** The tool-parameter name of a flag. */
export function paramName(flag: FlagSpec): string {
  return flag.param ?? flag.name;
}

/** The flags a tool exposes: everything the command line takes except `cliOnly`. */
export function toolFlags(gate: GateCommand): readonly FlagSpec[] {
  return gate.flags.filter((f) => f.cliOnly !== true);
}

/** One flag as one parameter schema, described by the flag's description; a
 *  `json` flag's own schema wins, descriptions included, because that schema
 *  is verbatim what the model used to read. */
function paramSchema(flag: FlagSpec): TSchema {
  const meta = { description: flag.description };
  switch (flag.kind) {
    case "boolean":
      return Type.Boolean(meta);
    case "number":
      return Type.Number(meta);
    case "string":
      return flag.repeatable === true ? Type.Array(Type.String(), meta) : Type.String(meta);
    case "json":
      return flag.jsonSchema === undefined ? Type.Unknown(meta) : Type.Unsafe({ ...meta, ...flag.jsonSchema });
  }
}

/** The tool's parameter schema: the gate's non-`cliOnly` flags plus `cwd`. */
export function toolParams(gate: GateCommand): TObject<Record<string, TSchema>> {
  const properties: Record<string, TSchema> = {};
  for (const flag of toolFlags(gate)) {
    const schema = paramSchema(flag);
    properties[paramName(flag)] = flag.required === true ? schema : Type.Optional(schema);
  }
  properties["cwd"] = cwdParam();
  return Type.Object(properties);
}

/** The tool's parameters as the args the gate's `run` reads. An absent
 *  parameter stays absent, so `run` sees exactly what an omitted flag is. */
export function gateArgsFrom(gate: GateCommand, params: Readonly<Record<string, unknown>>): GateArgs {
  const args: Record<string, unknown> = {};
  for (const flag of toolFlags(gate)) {
    const value = params[paramName(flag)];
    if (value !== undefined) args[flag.name] = value;
  }
  return args;
}

/** A `cliOnly` flag named `role` marks a gate that scopes by the session's role. */
function takesSessionRole(gate: GateCommand): boolean {
  return gate.flags.some((f) => f.cliOnly === true && f.name === "role");
}

/** The args the host adds on the session's behalf: `role`, when the gate
 *  takes one and the session has one. Absent stays absent — unscoped. */
export function hostArgs(gate: GateCommand, sessionCwd: string): GateArgs {
  if (!takesSessionRole(gate)) return {};
  const role = sessionRole(sessionCwd);
  return role === undefined ? {} : { role };
}

/** pi's UI label, from the tool name: `check_drift` → "Check Drift". */
function labelOf(tool: string): string {
  return tool
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function stringParam(params: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = params[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Register one pi tool per registry entry whose `tool` is in `tools`. The
 * set is the host's statement of which gates this extension offers — the
 * architect's roster and the workers' are two extensions over one registry.
 */
export function registerGateTools(
  pi: ExtensionAPI,
  gates: readonly GateCommand[],
  tools: ReadonlySet<string>,
): void {
  for (const gate of gates) {
    const tool = gate.tool;
    if (tool === undefined || !tools.has(tool)) continue;
    pi.registerTool({
      name: tool,
      label: labelOf(tool),
      description: gate.description,
      ...(gate.promptSnippet === undefined ? {} : { promptSnippet: gate.promptSnippet }),
      ...(gate.promptGuidelines === undefined ? {} : { promptGuidelines: [...gate.promptGuidelines] }),
      parameters: toolParams(gate),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const cwd = targetCwd(ctx.cwd, stringParam(params, "cwd"));
        // In a ticket worktree the board follows the gate (ADR 2026-066).
        const result = await runGateWithBoard(cwd, gate,
          () => gate.run(cwd, { ...gateArgsFrom(gate, params), ...hostArgs(gate, ctx.cwd) }), openTracker, sessionRole(ctx.cwd));
        // A cancelled call reports the cancellation, not a verdict the caller
        // never waited for (the gate itself has already run to completion).
        if (signal?.aborted) return { content: [{ type: "text", text: `${tool}: cancelled` }], details: {} };
        const text = [...result.lines, verdictLine(gate.name, result.code)].join("\n");
        return { content: [{ type: "text", text }], details: { code: result.code, ok: result.code === 0 } };
      },
    });
  }
}
