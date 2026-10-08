import type { Result } from "../shared/result.ts";
import type { AgentName } from "./agent-name.contract.ts";
import type { Command } from "./command.contract.ts";
import type { NamePattern } from "./name-pattern.contract.ts";
import type { ProjectPath } from "./project-path.contract.ts";
import type { ToolName } from "./tool-name.contract.ts";
import type { Url } from "./url.contract.ts";

/** The brand only Effect itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const effectBrand: unique symbol;

export type Change = "create" | "modify" | "delete";

/** What every effect is: a value object of one kind, equal by value, whose wire form is a plain object. */
interface EffectOf<Kind extends string, Wire> {
  readonly __brand: "Effect";
  readonly [effectBrand]: true;
  readonly kind: Kind;
  equals(other: Effect): boolean;
  toJSON(): Wire;
}

/** Reads a file's contents. */
export interface ReadEffect extends EffectOf<"read", ReadEffectJSON> {
  readonly path: ProjectPath;
}

/** Lists names under a directory (no contents), optionally limited by a file-name pattern. */
export interface ListEffect extends EffectOf<"list", ListEffectJSON> {
  readonly root: ProjectPath;
  readonly filter: NamePattern | null;
}

/** Creates, modifies or deletes a file. A rename is a delete and a create. */
export interface WriteEffect extends EffectOf<"write", WriteEffectJSON> {
  readonly path: ProjectPath;
  readonly change: Change;
}

/** Runs a shell command, and nothing else. */
export interface ExecuteEffect extends EffectOf<"execute", ExecuteEffectJSON> {
  readonly command: Command;
  /** The project directory the command runs in, when the host says; adapters refuse a directory outside the project. */
  readonly cwd: ProjectPath | null;
}

/** Reaches the network. */
export interface FetchEffect extends EffectOf<"fetch", FetchEffectJSON> {
  readonly url: Url;
}

/** Hands work to another agent. */
export interface DelegateEffect extends EffectOf<"delegate", DelegateEffectJSON> {
  readonly agent: AgentName;
}

/** Calls a tool whose effects the host cannot describe: an unknown tool, a tool from another server, a skill. */
export interface InvokeEffect extends EffectOf<"invoke", InvokeEffectJSON> {
  readonly name: ToolName;
}

/** Refuses a map whose entry's `kind` differs from its key. */
export type KindsMatch<T extends { readonly [K in keyof T]: { readonly kind: K } }> = T;

/** Each effect by its kind: the one place an effect kind meets its type, so guard points and dispatch are derived from it. */
export type EffectByKind = KindsMatch<{
  read: ReadEffect;
  list: ListEffect;
  write: WriteEffect;
  execute: ExecuteEffect;
  fetch: FetchEffect;
  delegate: DelegateEffect;
  invoke: InvokeEffect;
}>;
export type EffectKind = keyof EffectByKind;
/** One precise thing a tool call does. A call has one or more. */
export type Effect = EffectByKind[EffectKind];

// Wire forms: what each effect's toJSON gives and Effect.parse takes. Host
// adapters build these; a list's filter and an execute's cwd may be left out.
export interface ReadEffectJSON {
  readonly kind: "read";
  readonly path: string;
}
export interface ListEffectJSON {
  readonly kind: "list";
  readonly root: string;
  readonly filter?: string | null;
}
export interface WriteEffectJSON {
  readonly kind: "write";
  readonly path: string;
  readonly change: Change;
}
export interface ExecuteEffectJSON {
  readonly kind: "execute";
  readonly command: string;
  readonly cwd?: string | null;
}
export interface FetchEffectJSON {
  readonly kind: "fetch";
  readonly url: string;
}
export interface DelegateEffectJSON {
  readonly kind: "delegate";
  readonly agent: string;
}
export interface InvokeEffectJSON {
  readonly kind: "invoke";
  readonly name: string;
}
export type EffectJSON = ReadEffectJSON | ListEffectJSON | WriteEffectJSON | ExecuteEffectJSON | FetchEffectJSON | DelegateEffectJSON | InvokeEffectJSON;

export interface EffectFactory {
  /** A frozen effect from its wire form, or why the value is not one. Never throws. */
  parse(raw: unknown): Result<Effect>;
}
