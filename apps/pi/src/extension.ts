// The pi extension: composes the project's guards at session start, then
// turns every tool call into a tool use, decides it and answers pi. Anything
// it cannot read, translate or decide in time blocks the call: it fails
// closed, and records the block when the project can. After a tool ran, the
// project checks it, and what it undid is added to the result the agent sees.
import { isAbsolute } from "node:path";
import { ToolResult, ToolUse as Use, Verdict } from "bounded/domain";
import type { ToolUse } from "./event.ts";
import { locator } from "./pi-path.ts";
import { translate } from "./translate.ts";

/** A block the extension made itself, before the project judged anything: what the project's guard log records. */
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

/** The part of pi's ExtensionAPI this extension uses. */
export interface Pi {
  on(event: "session_start" | "tool_call" | "tool_result", handler: PiHandler): unknown;
}

export interface ExtensionOptions {
  /** The project's root directory. */
  readonly projectRoot: string;
  readonly load: LoadJudge;
  /** The home directory pi expands '~' to; the user's by default. */
  readonly home?: string;
  /** How long deciding one call may take before the call is blocked. 3 seconds by default. */
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
export function piExtension({ projectRoot, load, home, deadlineMs = 3000, composeDeadlineMs = 15000, composeBackoffMs = 30000 }: ExtensionOptions): (pi: Pi) => void {
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

    // Composition starts here and is awaited by the calls that need it, so a
    // slow composition never delays the session itself.
    pi.on("session_start", async () => {
      started = true;
      retryAt = undefined;
      composed = compose();
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
          const translated = translate({ toolName, input }, cwd, locate);
          if (!translated.ok) return blocked(`bounded cannot check pi's ${toolName} call: ${translated.error}`, "Use paths inside the project, spelled plainly, and the tool's documented arguments");
          const use = Use.parse({ ...translated.value.toJSON(), ...callIdOf(event) });
          if (!use.ok) return blocked(`bounded cannot check pi's ${toolName} call: ${use.error}`, "Report this to the maintainers of bounded-pi");
          const decided = await within(() => project.decide(use.value), deadlineMs, `bounded did not decide within ${deadlineMs} ms on pi's ${toolName} call`);
          const verdict = Verdict.parse(decided);
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
      const project = started ? await composed : undefined;
      const decide = project?.ok ? project.decide : undefined;
      const afterTool = decide?.afterTool;
      if (decide === undefined || afterTool === undefined) return undefined;
      let told: string | null;
      try {
        const [toolName, cwd] = [field(event, "toolName"), field(context, "cwd")];
        if (typeof toolName !== "string" || toolName === "") throw new Error("pi's tool result names no tool");
        const use = typeof cwd === "string" && isAbsolute(cwd) ? translate({ toolName, input: field(event, "input") }, cwd, locate) : undefined;
        const result = ToolResult.parse({
          ...(use?.ok ? use.value.toJSON() : { role: null, tool: "other", effects: [{ kind: "invoke", name: toolName }] }),
          kind: "tool-result",
          ok: field(event, "isError") !== true,
          ...callIdOf(event),
        });
        if (!result.ok) throw new Error(result.error);
        told = (await within(() => afterTool(result.value), deadlineMs, `no answer within ${deadlineMs} ms`)).message;
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
