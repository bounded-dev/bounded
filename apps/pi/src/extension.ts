// The pi extension: composes the project's guards at session start, then
// turns every tool call into a tool use, decides it and answers pi. Anything
// it cannot read, translate or decide in time blocks the call: it fails closed.
import { isAbsolute } from "node:path";
import { Verdict } from "bounded/domain";
import type { ToolUse } from "./event.ts";
import { locator } from "./pi-path.ts";
import { translate } from "./translate.ts";

/** Decides one tool use: the composed project's guards, dispatched. */
export type Decide = (event: ToolUse) => Promise<Verdict>;

/** The composition root's seam: composes the project once and gives its decide. May reject. */
export type Load = () => Promise<Decide>;

/** What pi does with a handler's answer: undefined runs the call; a block stops it, telling the agent why. */
export interface PiBlock {
  readonly block: true;
  readonly reason: string;
}

/** A handler as pi calls it, and awaits. Event and context are read defensively: they come from the host. */
export type PiHandler = (event: unknown, context: unknown) => Promise<PiBlock | undefined>;

/** The part of pi's ExtensionAPI this extension uses. */
export interface Pi {
  on(event: "session_start" | "tool_call", handler: PiHandler): unknown;
}

export interface ExtensionOptions {
  /** The project's root directory. */
  readonly root: string;
  readonly load: Load;
  /** The home directory pi expands '~' to; the user's by default. */
  readonly home?: string;
  /** How long composing, and deciding one call, may take before the call is blocked. 3 seconds by default. */
  readonly deadlineMs?: number;
}

const block = (reason: string, redirect: string): PiBlock => ({ block: true, reason: `${reason}\n${redirect}` });
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const field = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null && Object.hasOwn(value, name) ? (value as Record<string, unknown>)[name] : undefined);

/** `work`, or a rejection saying `late` once `ms` have passed. */
function within<T>(work: () => Promise<T>, ms: number, late: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(late)), ms);
  });
  return Promise.race([Promise.resolve().then(work), deadline]).finally(() => clearTimeout(timer));
}

/** Freezes `value` and everything inside it, so a later handler cannot change what was judged. */
function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
}

type Composed = { ok: true; decide: Decide } | { ok: false; error: string };

/** The extension pi loads: `(pi) => void`, given the project and its composition root. */
export function piExtension({ root, load, home, deadlineMs = 3000 }: ExtensionOptions): (pi: Pi) => void {
  const locate = locator(root, home);
  return (pi) => {
    let composed: Promise<Composed> | undefined;

    // Composition starts here and is awaited by the calls that need it, so a
    // slow composition never delays the session itself.
    pi.on("session_start", async () => {
      composed = within(load, deadlineMs, `composing the project did not finish within ${deadlineMs} ms`).then(
        (decide): Composed => ({ ok: true, decide }),
        (error): Composed => ({ ok: false, error: message(error) }),
      );
      return undefined;
    });

    pi.on("tool_call", async (event, context) => {
      try {
        if (composed === undefined) return block("bounded blocked this call: it came before the session started", "Start a new pi session in this project");
        const project = await composed;
        if (!project.ok) return block(`bounded could not start: ${project.error}`, "Fix the project's bounded configuration, then start a new pi session");
        const [toolName, input, cwd] = [field(event, "toolName"), field(event, "input"), field(context, "cwd")];
        if (typeof toolName !== "string") return block("bounded could not read pi's tool call: it names no tool", "Report this to the maintainers of bounded-pi");
        if (typeof cwd !== "string" || !isAbsolute(cwd)) return block(`bounded could not read pi's context for the ${toolName} call: its cwd is not an absolute directory`, "Report this to the maintainers of bounded-pi");
        const use = translate({ toolName, input }, cwd, locate);
        if (!use.ok) return block(`bounded cannot check pi's ${toolName} call: ${use.error}`, "Use paths inside the project, spelled plainly, and the tool's documented arguments");
        const decided = await within(() => project.decide(use.value), deadlineMs, `bounded did not decide within ${deadlineMs} ms on pi's ${toolName} call`);
        const verdict = Verdict.parse(decided);
        if (!verdict.ok) return block(`bounded's decision for the ${toolName} call is not a verdict: ${verdict.error}`, "Report this to the maintainers of the project's packs");
        if (verdict.value.kind === "refuse") return block(verdict.value.reason, verdict.value.redirect);
        deepFreeze(input);
        return undefined;
      } catch (error) {
        return block(`bounded failed while checking this call: ${message(error)}`, "The call stays blocked until the failure is fixed; report it to the maintainers");
      }
    });
  };
}
