// pi's tools for the team lead's commands (src/lead-commands.ts, ADR 2026-066).
// Each tool turns its parameters into the shell form's arguments and goes
// through the same parser, so a tool accepts exactly what `bounded lead`
// accepts, then runs the command in-process against the project's tracker.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { LEAD_COMMANDS, leadDeps, parseLeadArgs, runLeadCommand } from "../../../../src/lead-commands.ts";
import { LEAD_COMMAND_TOOLS } from "../../../../src/lead-policy.ts";
import { openTracker } from "../../../../trackers/index.ts";

type Params = Readonly<Record<string, unknown>>;

const text = (description: string) => Type.String({ description });
const ISSUE = text("The ticket's issue number");

/** Each command's parameters, and how they become the shell form's arguments. */
const SHAPES: Readonly<Record<string, { readonly parameters: TSchema; readonly argv: (p: Params) => string[] }>> = {
  "ticket create": {
    parameters: Type.Object({
      title: text("One-line title"),
      outcome: text("The outcome the ticket delivers"),
      acceptance: text("Its acceptance criteria"),
      owns: Type.Array(Type.String(), { description: "The project-relative contract paths only this ticket may change" }),
      depends: Type.Optional(Type.Array(Type.String(), { description: "Issue numbers whose design handoff this ticket needs" })),
      decisions: text("The decisions the architect must return to the user"),
    }),
    argv: (p) => [
      "ticket", "create", "--title", String(p["title"] ?? ""), "--outcome", String(p["outcome"] ?? ""),
      "--acceptance", String(p["acceptance"] ?? ""),
      ...((p["owns"] as unknown[] | undefined) ?? []).flatMap((path) => ["--owns", String(path)]),
      ...((p["depends"] as unknown[] | undefined) ?? []).flatMap((issue) => ["--depends", String(issue)]),
      "--decisions", String(p["decisions"] ?? ""),
    ],
  },
  queue: { parameters: Type.Object({ issue: ISSUE }), argv: (p) => ["queue", String(p["issue"] ?? "")] },
  start: { parameters: Type.Object({ issue: ISSUE }), argv: (p) => ["start", String(p["issue"] ?? "")] },
  status: { parameters: Type.Object({}), argv: () => ["status"] },
  reply: {
    parameters: Type.Object({ issue: ISSUE, message: text("The user's answer, passed to the architect") }),
    argv: (p) => ["reply", String(p["issue"] ?? ""), String(p["message"] ?? "")],
  },
  merge: { parameters: Type.Object({ issue: ISSUE }), argv: (p) => ["merge", String(p["issue"] ?? "")] },
};

/** The argv a lead command tool's parameters stand for (exported for tests). */
export function leadToolArgv(command: string, params: Params): string[] {
  const shape = SHAPES[command];
  if (shape === undefined) throw new Error(`no lead command '${command}'`);
  return shape.argv(params);
}

export function registerLeadCommandTools(pi: ExtensionAPI, leadSession: (cwd: string) => boolean): void {
  for (const spec of LEAD_COMMANDS) {
    const shape = SHAPES[spec.name];
    const name = LEAD_COMMAND_TOOLS[spec.name];
    if (shape === undefined || name === undefined) throw new Error(`lead command '${spec.name}' has no pi tool`);
    pi.registerTool({
      name,
      label: `Lead: ${spec.name}`,
      description: `${spec.summary} (the shell form is \`${spec.usage}\`).`,
      parameters: shape.parameters,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const reply = (body: string, ok: boolean) => ({ content: [{ type: "text" as const, text: body }], details: { ok } });
        if (!leadSession(ctx.cwd)) return reply("team-lead: only the project-local lead in the main worktree runs lead commands", false);
        const parsed = parseLeadArgs(shape.argv(params as Params));
        if (!parsed.ok) return reply(`team-lead: ${parsed.reason}`, false);
        const outcome = await runLeadCommand(ctx.cwd, parsed.request, leadDeps(openTracker, "pi"));
        return reply(outcome.text, outcome.ok);
      },
    });
  }
}
