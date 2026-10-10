// The pi extension: composes the project's guards and starts preparing the
// shell command reader at session start, then turns every tool call into a
// tool use, reading its shell commands (ADR 2026-020), decides it and
// answers pi. Anything it cannot read, translate or decide in time blocks
// the call: it fails closed, and records the block when the project can.
// After a tool ran, the project checks it, and what it undid is added to the
// result the agent sees. pi-subagents' completions, observed on pi's event
// bus, are recorded as the finish of the runs they name (ADR 2026-028).
import { isAbsolute } from "node:path";
import { type DelegatedAgentRunJSON, ToolResult, Verdict } from "bounded/domain";
import type { ReadShellCommand } from "bounded-shell-command-reader/shell-command-reading";
import { type ToolUse, toolUse } from "./event.ts";
import { locator } from "./pi-path.ts";
import { ASYNC_COMPLETE_CHANNEL, ObservedSubagentRuns, readCompletion } from "./subagent-runs.ts";
import { translate } from "./translate.ts";

/** A block the extension made itself, before the project judged anything: what the project's Bounded log records. */
export interface AdapterRefusal {
  readonly hostToolName: string;
  readonly reason: string;
  readonly redirect: string;
  readonly role: null;
  readonly input: unknown;
}

/** Decides one tool use: the composed project's guards, dispatched. */
export interface ProjectJudgeForPi {
  (event: ToolUse): Promise<Verdict>;
  /** After a tool ran: what the project undid, to tell the agent; null when nothing. */
  readonly afterTool?: (result: ToolResult) => Promise<{ readonly message: string | null }>;
  /** Records a block the extension made itself. Its outcome never changes or delays the block. */
  readonly refuse?: (refusal: AdapterRefusal) => Promise<unknown>;
  /** Records a delegated agent run's finish, in the core's wire form (ADR 2026-025): what pi-subagents' completion says (ADR 2026-028). */
  readonly recordAgentRunFinish?: (finish: unknown) => Promise<unknown>;
}

/** The composition root's seam: composes the project once and gives its decide. May reject. */
export type LoadJudge = () => Promise<ProjectJudgeForPi>;

/** What pi does with a handler's answer: undefined runs the call; a block stops it, telling the agent why. */
export interface PiBlock {
  readonly block: true;
  readonly reason: string;
}

/** What pi does with a tool_result handler's answer: the result's content and error flag, replaced. */
export interface PiResultPatch {
  readonly content: readonly unknown[];
  readonly isError: true;
}

/** A handler as pi calls it, and awaits. Event and context are read defensively: they come from the host. */
export type PiHandler = (event: unknown, context: unknown) => Promise<PiBlock | PiResultPatch | undefined>;

/** A handler on pi's event bus. pi does not await it, and catches what it throws (pi 0.87.1, dist/core/event-bus.js:2-23). */
export type PiBusHandler = (data: unknown) => Promise<void>;

/** The part of pi's ExtensionAPI this extension uses. */
export interface Pi {
  on(event: "session_start" | "tool_call" | "tool_result", handler: PiHandler): unknown;
  /**
   * pi's event bus, shared by the extensions it loads (dist/core/extensions/types.d.ts:1157-1158).
   * When absent, no async run's finish is observed, and an async launch says its finish is never reported.
   */
  readonly events?: {
    on(channel: string, handler: PiBusHandler): unknown;
  };
}

export interface ExtensionOptions {
  /** The project's root directory. */
  readonly projectRoot: string;
  readonly load: LoadJudge;
  /** Reads each shell command into the reading its execute effect carries: bounded's reader in the composition root. */
  readonly readShellCommand: ReadShellCommand;
  /** The home directory pi expands '~' to; the user's by default. */
  readonly home?: string;
  /** How long reading one call's shell commands and deciding it may take before the call is blocked. 3 seconds by default. */
  readonly deadlineMs?: number;
  /** How long composing may take before the waiting calls are blocked. 15 seconds by default. */
  readonly composeDeadlineMs?: number;
  /** After a composition times out, how long calls stay blocked before one composes again. 30 seconds by default. */
  readonly composeBackoffMs?: number;
}

const block = (reason: string, redirect: string): PiBlock => ({ block: true, reason: `${reason}\n${redirect}` });
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const field = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null && Object.hasOwn(value, name) ? (value as Record<string, unknown>)[name] : undefined);

class TimedOut extends Error {}

/** `work`, or a rejection saying `late` once `ms` have passed. */
function within<T>(work: () => Promise<T>, ms: number, late: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut(late)), ms);
  });
  return Promise.race([Promise.resolve().then(work), deadline]).finally(() => clearTimeout(timer));
}

/** Freezes `value` and everything inside it, frozen parents included, so nothing can change what is judged. */
function deepFreeze(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner, seen);
}

type Composed = { ok: true; decide: ProjectJudgeForPi } | { ok: false; error: string; timedOut: boolean };

/** pi's call id, when it gives one. */
const callIdOf = (event: unknown): { callId?: string } => {
  const id = field(event, "toolCallId");
  return typeof id === "string" && id !== "" ? { callId: id } : {};
};

/** Hands a refusal the extension made itself to the project's refuse, without waiting for it or letting it fail. */
function record(decide: ProjectJudgeForPi, event: unknown, reason: string, redirect: string): void {
  const { refuse } = decide;
  if (refuse === undefined) return;
  const tool = field(event, "toolName");
  const refusal: AdapterRefusal = { hostToolName: typeof tool === "string" && tool !== "" ? tool : "unknown", reason, redirect, role: null, input: field(event, "input") ?? null };
  Promise.resolve()
    .then(() => refuse(refusal))
    .catch(() => {});
}

/** The extension pi loads: `(pi) => void`, given the project and its composition root. */
export function piExtension({ projectRoot, load, readShellCommand, home, deadlineMs = 3000, composeDeadlineMs = 15000, composeBackoffMs = 30000 }: ExtensionOptions): (pi: Pi) => void {
  const locate = locator(projectRoot, home);
  return (pi) => {
    let started = false;
    /** The composition calls wait for. */
    let composed: Promise<Composed> | undefined;
    /** After a composition ran out of time, when the first call may compose again: a back-off, so slow imports do not pile up. */
    let retryAt: number | undefined;
    const compose = (): Promise<Composed> =>
      within(load, composeDeadlineMs, `composing the project did not finish within ${composeDeadlineMs} ms`).then(
        (decide): Composed => ({ ok: true, decide }),
        (error): Composed => ({ ok: false, error: message(error), timedOut: error instanceof TimedOut }),
      );

    /** pi-subagents' runs bounded saw in this load, in memory only: what ties a resume to an agent (ADR 2026-028). */
    const subagentRuns = new ObservedSubagentRuns();
    const agentOfRun = (runId: string): string | undefined => subagentRuns.agentOf(runId);
    /** Whether pi-subagents' completions are observed: only then does an async launch's finish come later. */
    let completionsObserved = false;
    // Subscribed once, when the extension loads. pi unsubscribes it when it invalidates this
    // extension's context, on a reload or a session replacement (dist/core/extensions/loader.js:142-155).
    if (pi.events !== undefined) {
      try {
        pi.events.on(ASYNC_COMPLETE_CHANNEL, async (payload) => {
          // Read now, before any await, into plain values: nothing done to the shared payload later changes what is recorded.
          const completion = readCompletion(payload);
          subagentRuns.completed(completion);
          const project = started ? composed : undefined;
          if (completion.finish === undefined || project === undefined) return;
          try {
            const current = await project;
            const recordAgentRunFinish = current.ok ? current.decide.recordAgentRunFinish : undefined;
            if (recordAgentRunFinish !== undefined) await recordAgentRunFinish(completion.finish);
          } catch {
            // Not recorded: a finish carries no verdict to enforce, and pi would only log the failure.
          }
        });
        completionsObserved = true;
      } catch {
        // No completion is observed: every async launch says its finish is never reported.
      }
    }

    // Composition and the shell command reader's preparation start here; calls
    // await what they need, so neither ever delays the session itself.
    pi.on("session_start", async () => {
      started = true;
      retryAt = undefined;
      composed = compose();
      // Never rejects; a call made while it still runs waits for it within the reader's bounds and the call's deadline.
      void readShellCommand.prepare();
      return undefined;
    });

    pi.on("tool_call", async (event, context) => {
      try {
        if (!started) return block("bounded blocked this call: it came before the session started", "Start a new pi session in this project");
        if (retryAt !== undefined && Date.now() >= retryAt) {
          retryAt = undefined;
          composed = compose();
        }
        const current = composed ?? compose();
        const project = await current;
        if (!project.ok && project.timedOut) {
          if (composed === current && retryAt === undefined) retryAt = Date.now() + composeBackoffMs;
          const wait = Math.max(0, (retryAt ?? Date.now()) - Date.now()) / 1000;
          return block(
            `bounded could not start: composing the project timed out (${project.error}); bounded retries in ${wait.toFixed(1)} s`,
            "Calls are blocked until the project composes; check what makes bounded.config.ts slow to load",
          );
        }
        if (!project.ok) return block(`bounded could not start: ${project.error}`, "Fix the project's bounded configuration, then start a new pi session");
        // A block made here, not by the project's guards: recorded without waiting, never failing the block.
        const blocked = (reason: string, redirect: string): PiBlock => {
          record(project.decide, event, reason, redirect);
          return block(reason, redirect);
        };
        try {
          const [toolName, input, cwd] = [field(event, "toolName"), field(event, "input"), field(context, "cwd")];
          deepFreeze(input);
          if (typeof toolName !== "string") return blocked("bounded could not read pi's tool call: it names no tool", "Report this to the maintainers of bounded-pi");
          if (typeof cwd !== "string" || !isAbsolute(cwd)) return blocked(`bounded could not read pi's context for the ${toolName} call: its cwd is not an absolute directory`, "Report this to the maintainers of bounded-pi");
          const translated = translate({ toolName, input }, cwd, locate, agentOfRun);
          if (!translated.ok) return blocked(`bounded cannot check pi's ${toolName} call: ${translated.error}`, translated.redirect ?? "Use paths inside the project, spelled plainly, and the tool's documented arguments");
          const call = translated.value;
          // Reading the call's shell commands and deciding share the decision's deadline.
          const outcome = await within(
            async (): Promise<{ readonly unusable: string } | { readonly decided: unknown }> => {
              const use = await toolUse(null, call, { projectRoot, readShellCommand, ...callIdOf(event) });
              return use.ok ? { decided: await project.decide(use.value) } : { unusable: use.error };
            },
            deadlineMs,
            `bounded did not decide within ${deadlineMs} ms on pi's ${toolName} call`,
          );
          if ("unusable" in outcome) return blocked(`bounded cannot check pi's ${toolName} call: ${outcome.unusable}`, "Report this to the maintainers of bounded-pi");
          const verdict = Verdict.parse(outcome.decided);
          if (!verdict.ok) return blocked(`bounded's decision for the ${toolName} call is not a verdict: ${verdict.error}`, "Report this to the maintainers of the project's packs");
          return verdict.value.kind === "refuse" ? block(verdict.value.reason, verdict.value.redirect) : undefined;
        } catch (error) {
          return blocked(`bounded failed while checking this call: ${message(error)}`, "The call stays blocked until the failure is fixed; report it to the maintainers");
        }
      } catch (error) {
        return block(`bounded failed while checking this call: ${message(error)}`, "The call stays blocked until the failure is fixed; report it to the maintainers");
      }
    });

    // After a tool ran: the project checks it; what it undid, or that checking failed, is added to what the agent sees.
    pi.on("tool_result", async (event, context) => {
      // The call is translated, and what its result says of a subagent run read and remembered, when the
      // result arrives, before any await: a completion that follows it then finds the launch (ADR 2026-028).
      let call: ReturnType<typeof translate> | undefined;
      let delegatedAgentRuns: DelegatedAgentRunJSON[] | undefined;
      let unreadable: unknown;
      try {
        const [toolName, cwd, input] = [field(event, "toolName"), field(context, "cwd"), field(event, "input")];
        if (typeof toolName === "string" && toolName !== "" && typeof cwd === "string" && isAbsolute(cwd)) call = translate({ toolName, input }, cwd, locate, agentOfRun);
        if (call?.ok) {
          delegatedAgentRuns = subagentRuns.delegatedAgentRuns({
            delegatedAgents: call.value.effects.flatMap((effect) => (effect.kind === "delegate" ? [effect.agent] : [])),
            resume: toolName === "subagent" && field(input, "action") === "resume",
            callId: callIdOf(event).callId,
            isError: field(event, "isError"),
            details: field(event, "details"),
            completionsObserved,
          });
        }
      } catch (error) {
        unreadable = error;
      }
      const project = started ? await composed : undefined;
      const decide = project?.ok ? project.decide : undefined;
      const afterTool = decide?.afterTool;
      if (decide === undefined || afterTool === undefined) return undefined;
      let told: string | null;
      try {
        if (unreadable !== undefined) throw unreadable;
        const toolName = field(event, "toolName");
        if (typeof toolName !== "string" || toolName === "") throw new Error("pi's tool result names no tool");
        // Reading the result's shell commands again, after the call (the files they name may now exist), and the check share the deadline.
        const checked = async (): Promise<{ readonly message: string | null }> => {
          const use = call?.ok ? await toolUse(null, call.value, { projectRoot, readShellCommand, ...callIdOf(event) }) : undefined;
          const result = ToolResult.parse({
            ...(use?.ok ? use.value.toJSON() : { role: null, tool: "other", effects: [{ kind: "invoke", name: toolName }] }),
            kind: "tool-result",
            ok: field(event, "isError") !== true,
            ...callIdOf(event),
            ...(use?.ok && delegatedAgentRuns !== undefined ? { delegatedAgentRuns } : {}),
          });
          if (!result.ok) throw new Error(result.error);
          return afterTool(result.value);
        };
        told = (await within(checked, deadlineMs, `no answer within ${deadlineMs} ms`)).message;
      } catch (error) {
        told = `bounded could not check protected files after this call: ${message(error)}. Check them against version control.`;
        record(decide, event, told, "Check the protected files against version control");
      }
      if (told === null) return undefined;
      const content = field(event, "content");
      return { content: [...(Array.isArray(content) ? content : []), { type: "text", text: told }], isError: true };
    });
  };
}
