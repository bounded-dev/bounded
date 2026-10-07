import { own, readSafely, show } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { ProjectPath } from "./project-path.ts";
import { roleOf } from "./role.ts";
import type * as Contract from "./tool-use.contract.ts";

const TOOLS: readonly Contract.ToolKind[] = ["read", "search", "edit", "write", "shell", "web", "subagent", "other"];
const ACTIONS: readonly Contract.Action[] = ["read", "write", "run"];
const SEARCH = "A search is { root, filter }: root the project-relative directory searched, filter the file-name pattern that limits it, or null";

const one = <T extends string>(list: readonly T[], raw: unknown): raw is T => list.some((item) => item === raw);
const a = (word: string): string => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);
const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });

function parseSearch(raw: unknown): Result<Contract.Search | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object" || !Object.hasOwn(raw, "root")) return refuse(SEARCH);
  const filter = own(raw, "filter") ?? null;
  if (filter !== null && (typeof filter !== "string" || filter.trim() === "")) return refuse(SEARCH);
  const root = ProjectPath.parse(own(raw, "root"));
  return root.ok ? { ok: true, value: Object.freeze({ root: root.value, filter }) } : root;
}

// Each field is read once, own fields only; the result is a new frozen
// object holding nothing but the vocabulary's fields.
function check(raw: unknown): Result<ToolUse> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return refuse("A tool use is an object: { role, tool, action, paths, command, search }");
  const kind = own(raw, "kind");
  if (kind !== undefined && kind !== "tool-use") return refuse(`A tool use has kind 'tool-use', not '${show(kind)}'`);
  const role = roleOf(raw, "A tool use");
  if (!role.ok) return role;
  const [tool, action, rawPaths, command] = [own(raw, "tool"), own(raw, "action"), own(raw, "paths"), own(raw, "command")];
  if (!one(TOOLS, tool)) return refuse(`Tool kind '${show(tool)}' is not one of: ${TOOLS.join(", ")}`);
  if (!one(ACTIONS, action)) return refuse(`Action '${show(action)}' is not one of: ${ACTIONS.join(", ")}`);
  if (!Array.isArray(rawPaths)) return refuse("A tool use's paths must be a list of project-relative paths");
  const paths: ProjectPath[] = [];
  for (const path of rawPaths) {
    const parsed = ProjectPath.parse(path);
    if (!parsed.ok) return parsed;
    paths.push(parsed.value);
  }
  const search = parseSearch(own(raw, "search"));
  if (!search.ok) return search;
  if (search.value !== null && tool !== "search") return refuse(`Only a search carries search details; ${a(tool)} does not`);
  const common = { kind: "tool-use" as const, role: role.value, tool, paths: Object.freeze(paths), search: search.value };
  if (action === "run") {
    if (typeof command !== "string" || command.trim() === "") return refuse("A run must name the command it runs");
    if (command.includes("\0")) return refuse("A command must not contain a NUL character");
    return made({ ...common, action, command });
  }
  if (command !== undefined && command !== null) return refuse(`Only a run carries a command; ${a(action)} does not`);
  return made({ ...common, action, command: null });
}

/** The brand exists only in types: every tool use is made here, checked and frozen. */
function made(fields: Omit<ToolUse, "__brand">): Result<ToolUse> {
  return { ok: true, value: Object.freeze(fields) as ToolUse };
}

const parse = (raw: unknown): Result<ToolUse> => readSafely("A tool use", () => check(raw));

export type ToolUse = Contract.ToolUse;
export const ToolUse: Contract.ToolUseFactory = { parse };
