import type { AfterToolReport, ExtensionPoint, LifecycleContext, ToolResult, ToolUse } from "bounded/domain";
import { Verdict } from "bounded/domain";
import type { PathGateId } from "../../domain/path-gate-id.contract.ts";
import type { ProtectedPath } from "../../domain/protected-path.contract.ts";
import { watchedRulesOf } from "../../domain/watched-rules.ts";
import { shellSnapshotsPort, watchedFilesPort } from "./watch-shell.contract.ts";
import { WatchShellHandler } from "./watch-shell.handler.ts";

// The watch-shell feature as the core's lifecycle checks: they read the
// host's adapters from the context's ports, and map the feature's in port to
// what the core runs and records.

const UNREADABLE_REDIRECT = "Fix what stops protected files from being read; until then shell commands are refused";
const CHECK_REDIRECT = "Check the protected files by hand against version control";

const runsShell = (call: ToolUse | ToolResult): boolean => call.effects.some((effect) => effect.kind === "execute");

/** The feature for this project, or why its ports cannot be had; only a shell command meeting watched rules needs them. */
function handler(protectedPaths: ExtensionPoint<ProtectedPath, PathGateId>, { composition, ports }: LifecycleContext): WatchShellHandler | string {
  const files = ports.get(watchedFilesPort);
  if (!files.ok) return files.error;
  const snapshots = ports.get(shellSnapshotsPort);
  if (!snapshots.ok) return snapshots.error;
  return new WatchShellHandler(composition, protectedPaths, files.value, snapshots.value);
}

/** Whether anything is watched, so a missing port matters; rules that cannot be read count as watched, failing closed. */
function watchesAnything(protectedPaths: ExtensionPoint<ProtectedPath, PathGateId>, { composition }: LifecycleContext): boolean {
  const rules = watchedRulesOf(composition, protectedPaths);
  return !rules.ok || rules.value.length > 0;
}

/** Before a shell command runs: snapshot the files it must not change. */
export async function snapshotBeforeShell(protectedPaths: ExtensionPoint<ProtectedPath, PathGateId>, call: ToolUse, context: LifecycleContext): Promise<Verdict> {
  const watch = handler(protectedPaths, context);
  if (typeof watch !== "string") return watch.snapshot(call);
  if (!runsShell(call) || !watchesAnything(protectedPaths, context)) return Verdict.allow;
  return Verdict.refuse(`Protected files could not be checked before this command: ${watch}`, UNREADABLE_REDIRECT);
}

/** After a shell command ran: put back what it changed in watched files, and report it. */
export async function restoreWatched(protectedPaths: ExtensionPoint<ProtectedPath, PathGateId>, result: ToolResult, context: LifecycleContext): Promise<AfterToolReport> {
  const watch = handler(protectedPaths, context);
  if (typeof watch !== "string") {
    const { message, record } = await watch.verify(result);
    return { message, record };
  }
  if (!runsShell(result) || !watchesAnything(protectedPaths, context)) return { message: null, record: null };
  const message = `Protected files could not be checked after this command: ${watch}. Check them by hand against version control.`;
  const effect = result.effects.find((e) => e.kind === "execute") ?? null;
  return { message, record: { verdict: Verdict.refuse(message, CHECK_REDIRECT), refusedBy: { effect }, note: "could not be checked after a shell command" } };
}
