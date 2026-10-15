import type { packReadmeBrand } from "./pack-readme.contract.ts";
import type { Result } from "../shared/result.ts";
import type { CataloguedReadmeJSON, CataloguedSectionJSON } from "./package-catalog.contract.ts";
import type * as Contract from "./pack-readme.contract.ts";

/** The required sections, in the order a README gives them, each with the catalogue field it fills and what it says, for the fix. */
const REQUIRED: readonly { readonly heading: string; readonly field: Contract.RequiredReadmeField; readonly says: string }[] = [
  { heading: "What it is for", field: "whatItIsFor", says: "what the pack is for" },
  { heading: "Rule shape", field: "ruleShape", says: "the shape of what a project contributes, naming every point key as inline code" },
  { heading: "Workflows it fits", field: "workflowsItFits", says: "the workflows the pack fits" },
  { heading: "What it observes", field: "whatItObserves", says: "what the pack observes and when" },
  { heading: "What it cannot see", field: "whatItCannotSee", says: "what the pack cannot see" },
  { heading: "Ports", field: "ports", says: "the ports a host provides, naming every port key as inline code" },
  { heading: "Examples", field: "examples", says: "the pack's examples, in examples/" },
];

/** A code span naming a scenarios file: a name, or a path, ending `.scenarios.ts`. */
const SCENARIOS_FILE = /\.scenarios\.ts$/;
const quoted = (names: readonly string[]): string => names.map((name) => `'${name}'`).join(", ");

/**
 * Why the README does not name its examples as the rule wants, or undefined
 * when it does (ADR 2026-031): Examples names both files of each example as
 * inline code, by file name, and names no scenarios file that is not in
 * examples/; no other part names a scenarios file. Every problem is said.
 */
function examplesNotNamed(which: string, input: Contract.PackReadmeInput): string | undefined {
  const examples = input.sections.find((section) => section.heading === "Examples");
  const spans = examples?.codeSpans ?? [];
  const problems: string[] = [];
  const missing = input.exampleFileNames.filter((name) => !spans.includes(name));
  if (missing.length > 0) problems.push(`does not name ${quoted(missing)} as inline code in \`## Examples\`: name each example's \`<slug>.config.ts\` and \`<slug>.scenarios.ts\` there, by file name`);
  const unknown = [...new Set(spans.filter((span) => SCENARIOS_FILE.test(span) && !input.exampleFileNames.includes(span)))];
  if (unknown.length > 0) problems.push(`names ${quoted(unknown)} in \`## Examples\`, which is no file in the pack's examples/: name only its files, by file name`);
  const elsewhere = [{ heading: "the introduction", codeSpans: input.introduction.codeSpans }, ...input.sections.filter((section) => section !== examples).map((section) => ({ heading: `\`## ${section.heading}\``, codeSpans: section.codeSpans }))];
  for (const part of elsewhere) {
    const scenarios = [...new Set(part.codeSpans.filter((span) => SCENARIOS_FILE.test(span)))];
    if (scenarios.length > 0) problems.push(`names ${quoted(scenarios)} in ${part.heading}: a scenarios file is named only in \`## Examples\``);
  }
  return problems.length === 0 ? undefined : `${which} ${problems.join("; and ")}`;
}

class PackReadmeImpl implements Contract.PackReadme {
  declare readonly __brand: "PackReadme";
  declare readonly [packReadmeBrand]: true;

  private constructor(
    readonly summary: string,
    private readonly readme: CataloguedReadmeJSON,
  ) {
    Object.freeze(this);
  }

  static parse(input: Contract.PackReadmeInput): Result<Contract.PackReadme> {
    const { packId, path } = input;
    const which = `${path}, the README of ${packId},`;
    const titled = `# ${packId}: `;
    if (input.title === null) return { ok: false, error: `${which} has no title: begin it with \`${titled}<one-line summary>\`` };
    const title = `# ${input.title}`;
    const summary = title.startsWith(titled) ? title.slice(titled.length).trim() : "";
    if (summary === "") return { ok: false, error: `${which} is titled \`${title}\`: title it \`${titled}<one-line summary>\`, with the pack's exact id` };
    const fields: Partial<Record<Contract.RequiredReadmeField, string>> = {};
    const otherSections: CataloguedSectionJSON[] = [];
    const seen = new Set<string>();
    for (const section of input.sections) {
      const heading = `## ${section.heading}`;
      if (section.level !== undefined && section.level !== 2) return { ok: false, error: `${which} has a second title, \`# ${section.heading}\`: a README has one \`#\` title; make it \`${heading}\`` };
      if (seen.has(section.heading)) return { ok: false, error: `${which} has \`${heading}\` more than once: give each section once` };
      seen.add(section.heading);
      const configuration = section.codeBlocks.find((block) => block.includes("defineConfig("));
      if (configuration !== undefined) return { ok: false, error: `${which} holds a project configuration in \`${heading}\`: a README holds none; put it in examples/<slug>.config.ts, a tested example, and name it there` };
      const markdown = section.markdown.trim();
      const required = REQUIRED.find((candidate) => candidate.heading === section.heading);
      if (required === undefined) {
        otherSections.push({ heading: section.heading, markdown });
        continue;
      }
      if (markdown === "") return { ok: false, error: `${which} has an empty \`${heading}\` section: say ${required.says} there` };
      fields[required.field] = markdown;
    }
    if (input.introduction.codeBlocks.some((block) => block.includes("defineConfig("))) {
      return { ok: false, error: `${which} holds a project configuration before its first section: a README holds none; put it in examples/<slug>.config.ts, a tested example, and name it there` };
    }
    const missing = REQUIRED.find(({ field }) => fields[field] === undefined);
    if (missing !== undefined) return { ok: false, error: `${which} has no \`## ${missing.heading}\` section: add it, saying ${missing.says}` };
    const named = (heading: string, keys: readonly string[], what: string): string | undefined => {
      const spans = input.sections.find((section) => section.heading === heading)?.codeSpans ?? [];
      const unnamedKeys = keys.filter((key) => !spans.includes(key));
      return unnamedKeys.length === 0 ? undefined : `${which} does not name the ${what} ${unnamedKeys.map((key) => `'${key}'`).join(", ")} as inline code in \`## ${heading}\`: write each as \`${unnamedKeys[0]}\` there`;
    };
    const unnamed = named("Rule shape", input.pointKeys, "point key") ?? named("Ports", input.portKeys, "port key") ?? examplesNotNamed(which, input);
    if (unnamed !== undefined) return { ok: false, error: unnamed };
    const readme: CataloguedReadmeJSON = Object.freeze({
      path,
      introduction: input.introduction.markdown.trim(),
      whatItIsFor: fields.whatItIsFor ?? "",
      ruleShape: fields.ruleShape ?? "",
      workflowsItFits: fields.workflowsItFits ?? "",
      whatItObserves: fields.whatItObserves ?? "",
      whatItCannotSee: fields.whatItCannotSee ?? "",
      ports: fields.ports ?? "",
      examples: fields.examples ?? "",
      otherSections: Object.freeze(otherSections.map((section) => Object.freeze(section))),
    });
    return { ok: true, value: new PackReadmeImpl(summary, readme) };
  }

  toJSON(): CataloguedReadmeJSON {
    return this.readme;
  }
}

export type PackReadme = Contract.PackReadme;
export const PackReadme: Contract.PackReadmeFactory = PackReadmeImpl;
