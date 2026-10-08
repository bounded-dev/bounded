import type { Composition } from "../composition/composition.contract.ts";
import type { EffectByKind, EffectKind } from "../events/effect.contract.ts";
import type { SessionStart } from "../events/session-start.contract.ts";
import type { ToolUse } from "../events/tool-use.contract.ts";
import type { EffectGuard, Guard } from "../guards/dispatch.contract.ts";
import { point, pointGroup } from "../packs/pack.ts";
import { packIdsFor } from "../packs/pack-id.ts";
import type { Result } from "../shared/result.ts";
import type { AfterTool, BeforeTool, ProjectOpenHandler } from "./core.contract.ts";
import type * as Contract from "./guard-points.contract.ts";

/**
 * A check for function-valued points: a contributed value must be a
 * function. Its signature cannot be seen at run time, so this is the one
 * place a value is taken at its declared type (the one assertion rule R5
 * allows here); dispatch re-checks every verdict a guard returns, so a guard
 * of the wrong shape refuses rather than allows (ADR 2026-007).
 */
export function functionOf<G>(raw: unknown): Result<G> {
  return typeof raw === "function" ? { ok: true, value: raw as G } : { ok: false, error: "a guard is a function" };
}
/** The check for one effect kind's guards. */
const forEffect = <K extends EffectKind>(_kind: K) => functionOf<EffectGuard<EffectByKind[K], Composition>>;

export const coreId: Contract.CoreIdValue = packIdsFor("bounded")("core");

export const toolUseGuardsPoint: Contract.ToolUseGuardsPoint = point({ description: "Guards for whole tool calls, such as allowlists of tools", check: functionOf<Guard<ToolUse, Composition>> });

export const sessionStartGuardsPoint: Contract.SessionStartGuardsPoint = point({ description: "Guards for session starts", check: functionOf<Guard<SessionStart, Composition>> });

export const effectGuardsPoint: Contract.EffectGuardsPoint = pointGroup({
  read: point({ description: "Guards for reading a file's contents", check: forEffect("read") }),
  list: point({ description: "Guards for listing names under a directory", check: forEffect("list") }),
  write: point({ description: "Guards for creating, modifying or deleting a file", check: forEffect("write") }),
  execute: point({ description: "Guards for running a shell command", check: forEffect("execute") }),
  fetch: point({ description: "Guards for reaching the network", check: forEffect("fetch") }),
  delegate: point({ description: "Guards for handing work to another agent", check: forEffect("delegate") }),
  invoke: point({ description: "Guards for tools whose effects the host cannot describe", check: forEffect("invoke") }),
});

export const beforeToolPoint: Contract.BeforeToolPoint = point({ description: "Asynchronous checks run after the guards allow a tool call, before it runs; a refusal replaces the allow", check: functionOf<BeforeTool> });

export const afterToolPoint: Contract.AfterToolPoint = point({ description: "Asynchronous checks run after a tool call ran; what they report is recorded and told to the agent", check: functionOf<AfterTool> });

export const onProjectOpenPoint: Contract.OnProjectOpenPoint = point({
  description: "What a pack does once when a project opens, before any event is judged, such as loading what its guards need",
  check: functionOf<ProjectOpenHandler>,
});
