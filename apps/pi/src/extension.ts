// The pi extension: composes the project's guards at session start, then
// turns every tool call into a tool use, decides it and answers pi. Anything
// it cannot read, translate or decide blocks the call: it fails closed.
import { Verdict } from "bounded/domain";
import type { ToolUse } from "./event.ts";
import { locator } from "./pi-path.ts";
import { translate } from "./translate.ts";

/** Decides one tool use: the composed project's guards, dispatched. */
export type Decide = (event: ToolUse) => Verdict;

/** The composition root's seam: composes the project once and returns its decide. May throw. */
export type Load = () => Decide;

/** What pi does with a handler's answer: undefined runs the call; a block stops it, telling the agent why. */
export interface PiBlock {
  readonly block: true;
  readonly reason: string;
}

/** A handler as pi calls it. Event and context are read defensively: they come from the host. */
export type PiHandler = (event: unknown, context: unknown) => PiBlock | undefined;

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
}

const block = (reason: string, redirect: string): PiBlock => ({ block: true, reason: `${reason}\n${redirect}` });
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const field = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null && Object.hasOwn(value, name) ? (value as Record<string, unknown>)[name] : undefined);

type State = { kind: "waiting" } | { kind: "ready"; decide: Decide } | { kind: "failed"; error: string };

/** The extension pi loads: `(pi) => void`, given the project and its composition root. */
export function piExtension({ root, load, home }: ExtensionOptions): (pi: Pi) => void {
  const locate = locator(root, home);
  return (pi) => {
    let state: State = { kind: "waiting" };

    pi.on("session_start", () => {
      try {
        state = { kind: "ready", decide: load() };
      } catch (error) {
        state = { kind: "failed", error: message(error) };
      }
      return undefined;
    });

    pi.on("tool_call", (event, context) => {
      try {
        if (state.kind === "waiting") return block("bounded blocked this call: it came before the session started", "Start a new pi session in this project");
        if (state.kind === "failed") return block(`bounded could not start: ${state.error}`, "Fix the project's bounded configuration, then start a new pi session");
        const [toolName, input, cwd] = [field(event, "toolName"), field(event, "input"), field(context, "cwd")];
        if (typeof toolName !== "string") return block("bounded could not read pi's tool call: it names no tool", "Report this to the maintainers of bounded-pi");
        if (typeof cwd !== "string") return block(`bounded could not read pi's context for the ${toolName} call: it has no cwd`, "Report this to the maintainers of bounded-pi");
        const use = translate({ toolName, input }, cwd, locate);
        if (!use.ok) return block(`bounded cannot check pi's ${toolName} call: ${use.error}`, "Use paths inside the project, spelled plainly, and the tool's documented arguments");
        const verdict = Verdict.parse(state.decide(use.value));
        if (!verdict.ok) return block(`bounded's decision for the ${toolName} call is not a verdict: ${verdict.error}`, "Report this to the maintainers of the project's packs");
        return verdict.value.kind === "allow" ? undefined : block(verdict.value.reason, verdict.value.redirect);
      } catch (error) {
        return block(`bounded failed while checking this call: ${message(error)}`, "The call stays blocked until the failure is fixed; report it to the maintainers");
      }
    });
  };
}
