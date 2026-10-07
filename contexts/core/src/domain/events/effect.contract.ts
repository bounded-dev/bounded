import type { Result } from "../shared/result.ts";
import type { ProjectPath } from "./project-path.contract.ts";

/** Reads a file's contents. */
export interface ReadEffect {
  readonly kind: "read";
  readonly path: ProjectPath;
}

/** Lists names under a directory (no contents), optionally limited by a file-name pattern. */
export interface ListEffect {
  readonly kind: "list";
  readonly root: ProjectPath;
  readonly filter: string | null;
}

export type Change = "create" | "modify" | "delete";

/** Creates, modifies or deletes a file. A rename is a delete and a create. */
export interface WriteEffect {
  readonly kind: "write";
  readonly path: ProjectPath;
  readonly change: Change;
}

/** Runs a shell command. */
export interface ExecuteEffect {
  readonly kind: "execute";
  readonly command: string;
}

/** Reaches the network. */
export interface FetchEffect {
  readonly kind: "fetch";
  readonly url: string;
}

/** Hands work to another agent. */
export interface DelegateEffect {
  readonly kind: "delegate";
  readonly agent: string;
}

/** One precise thing a tool call does. A call has one or more. */
export type Effect = ReadEffect | ListEffect | WriteEffect | ExecuteEffect | FetchEffect | DelegateEffect;
export type EffectKind = Effect["kind"];

export interface EffectFactory {
  /** A frozen effect from its wire form, or why the value is not one. Never throws. */
  parse(raw: unknown): Result<Effect>;
}
