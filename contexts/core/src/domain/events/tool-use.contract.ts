import type { Result } from "../shared/result.ts";
import type { ProjectPath } from "./project-path.contract.ts";
import type { Role } from "./role.contract.ts";

/** What kind of tool acts, in words no host owns. */
export type ToolKind = "read" | "search" | "edit" | "write" | "shell" | "web" | "subagent" | "other";
export type Action = "read" | "write" | "run";

/** Where a search looks: the directory searched, and the file-name pattern that limits it, if any. */
export interface Search {
  readonly root: ProjectPath;
  readonly filter: string | null;
}

interface ToolUseFields {
  readonly __brand: "ToolUse";
  readonly kind: "tool-use";
  /** The acting role, or null when no role is active. */
  readonly role: Role | null;
  readonly tool: ToolKind;
  /** Every path the call touches, in the order given; a guard that refuses one refuses the call. */
  readonly paths: readonly ProjectPath[];
  /** Only a search has one, and only if the host says where it searches. */
  readonly search: Search | null;
}

/** An agent using a tool. Only a run has a command. Built only by `ToolUse.parse`. */
export type ToolUse = (ToolUseFields & { readonly action: "read" | "write"; readonly command: null }) | (ToolUseFields & { readonly action: "run"; readonly command: string });

export interface ToolUseFactory {
  /** A frozen tool use from its wire form, or why the value is not one. */
  parse(raw: unknown): Result<ToolUse>;
}
