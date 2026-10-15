import type { Composition, ExtensionPoint, PackId, Result, ToolKind } from "bounded/domain";

/** The brand only RefusedTool itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const refusedToolBrand: unique symbol;

/**
 * A tool kind a project refuses outright, and what to do instead. Events
 * name the kind of tool that acts, never a host's own tool name, so `tool`
 * is a tool kind.
 */
export interface RefusedTool {
  readonly __brand: "RefusedTool";
  readonly [refusedToolBrand]: true;
  readonly tool: ToolKind;
  readonly redirect: string;
  equals(other: RefusedTool): boolean;
  toJSON(): RefusedToolJSON;
}

/** A refused tool's wire form: what a project writes and RefusedTool.parse takes, and what toJSON gives back. */
export interface RefusedToolJSON {
  readonly tool: ToolKind;
  readonly redirect: string;
}

export interface RefusedToolFactory {
  /** A frozen refused tool, its redirect trimmed; or why the value is not one. */
  parse(raw: unknown): Result<RefusedTool>;
}

/** The refused-tools pack's rules in a composition, found by the declaration the pack made its point from; undefined when the pack is not selected. */
export type RefusedToolsIn = (composition: Composition) => ExtensionPoint<RefusedTool, PackId> | undefined;
