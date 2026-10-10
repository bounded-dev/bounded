import type { Result } from "../shared/result.ts";
import type { CataloguedReadmeJSON } from "./package-catalog.contract.ts";

/** The brand only PackReadme itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const packReadmeBrand: unique symbol;

/** A stretch of a README as a Markdown reader gives it: its Markdown, its inline code spans and its code blocks' text. */
export interface ReadmeText {
  readonly markdown: string;
  readonly codeSpans: readonly string[];
  readonly codeBlocks: readonly string[];
}

/** A section of a README: its heading's text and level (2 for `##`, the level when none is given), and its body up to the next heading of level one or two. */
export interface ReadmeSection extends ReadmeText {
  readonly heading: string;
  readonly level?: number;
}

/** A README as the package catalogue build reads it, with the keys its pack declares. */
export interface PackReadmeInput {
  readonly packId: string;
  /** The README's package-relative path, for messages and the catalogue. */
  readonly path: string;
  /** The text of its level-one heading, when it opens with one; null otherwise. */
  readonly title: string | null;
  /** What comes between the title and the first section. */
  readonly introduction: ReadmeText;
  readonly sections: readonly ReadmeSection[];
  /** The pack's point keys, which Rule shape names as inline code. */
  readonly pointKeys: readonly string[];
  /** The pack's port keys, which Ports names as inline code. */
  readonly portKeys: readonly string[];
}

/** The required sections, by heading, each with the catalogue field it fills and what it says. */
export type RequiredReadmeField = "whatItIsFor" | "ruleShape" | "workflowsItFits" | "whatItObserves" | "whatItCannotSee" | "ports" | "examples";

/**
 * A shipped pack's README, by the standard pack structure (ADR 2026-026):
 * titled `# <pack id>: <summary>`, with the seven required `##` sections
 * (What it is for, Rule shape, Workflows it fits, What it observes, What it
 * cannot see, Ports, Examples) once each, with a body; Rule shape names
 * every point key and Ports every port key as inline code; no code block
 * holds a project configuration, which the pack's examples are.
 */
export interface PackReadme {
  readonly __brand: "PackReadme";
  readonly [packReadmeBrand]: true;
  /** The title's text after `<pack id>: `. */
  readonly summary: string;
  /** What the package catalogue holds of it. */
  toJSON(): CataloguedReadmeJSON;
}

export interface PackReadmeFactory {
  /** The README, or a refusal naming the README, the pack, what is missing or wrong, and the fix. */
  parse(input: PackReadmeInput): Result<PackReadme>;
}
