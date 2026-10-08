// The one `bounded init` shape a project-local lead may run: re-planning the
// installation before the first ticket (ADR LEG-2026-065). Both hosts' entries
// judge the same shape with this parser, including the dependency-free
// bootstrap entries, so it imports nothing.

/** The re-plan command as the docs spell it. */
export const LEAD_REPLAN_USAGE =
  "bounded init --host <host> --surface <id>... [--without <id>...] [--pack <name>...] [--apply <digest>]";

const NAME = /^[a-z][a-z0-9-]*$/;
const DIGEST = /^[a-f0-9]{64}$/;
const VALUED = new Set(["--host", "--surface", "--without", "--pack", "--apply"]);

export interface ReplanRequest {
  readonly surfaces: readonly string[];
  readonly without: readonly string[];
  readonly packs: readonly string[];
  readonly apply?: string;
}

export type ReplanArgs =
  | ({ readonly ok: true } & ReplanRequest)
  | { readonly ok: false; readonly reason: string };

/** `init` arguments for `host`: plain names only, no other option (no
 *  `--cwd`, no `--interactive`), at least one surface or pack. */
export function parseReplanArgs(args: readonly string[], host: string): ReplanArgs {
  const usage = { ok: false as const, reason: `re-plan with exactly: ${LEAD_REPLAN_USAGE.replace("<host>", host)}` };
  // Bare `bounded init` only describes the choices; it writes nothing.
  if (args.length === 0) return { ok: true, surfaces: [], without: [], packs: [] };
  const surfaces: string[] = [];
  const without: string[] = [];
  const packs: string[] = [];
  let apply: string | undefined;
  let named: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (!VALUED.has(flag) || value === undefined) return usage;
    if (flag === "--apply") {
      if (apply !== undefined || !DIGEST.test(value)) return usage;
      apply = value;
      continue;
    }
    if (!NAME.test(value)) return usage;
    if (flag === "--host") {
      if (named !== undefined) return usage;
      named = value;
    } else (flag === "--surface" ? surfaces : flag === "--without" ? without : packs).push(value);
  }
  if (named !== host) return { ok: false, reason: `re-plan for this session's host: --host ${host}` };
  if (surfaces.length === 0 && packs.length === 0) return usage;
  return { ok: true, surfaces, without, packs, ...(apply !== undefined ? { apply } : {}) };
}

/** A shell command that is exactly `bounded init <args>`, in plain words
 *  separated by single spaces: no quoting, expansion, redirection or chaining. */
export function parseReplanCommand(command: unknown, host: string): ReplanArgs | undefined {
  if (typeof command !== "string" || !/^\s*bounded\s+init(?:\s|$)/.test(command)) return undefined;
  if (!/^bounded init(?: [A-Za-z0-9._-]+)*$/.test(command)) {
    return { ok: false, reason: `re-plan as one plain command: ${LEAD_REPLAN_USAGE.replace("<host>", host)}` };
  }
  return parseReplanArgs(command.split(" ").slice(2), host);
}

/** The CLI arguments for a parsed request. */
export function replanCliArgs(request: ReplanRequest, host: string): string[] {
  if (request.surfaces.length === 0 && request.packs.length === 0) return ["init"];
  return [
    "init", "--host", host,
    ...request.surfaces.flatMap((id) => ["--surface", id]),
    ...request.without.flatMap((id) => ["--without", id]),
    ...request.packs.flatMap((name) => ["--pack", name]),
    ...(request.apply !== undefined ? ["--apply", request.apply] : []),
  ];
}
