import { describe, expect, test } from "bun:test";
import { PackReadme } from "./pack-readme.ts";

const REQUIRED = ["What it is for", "Rule shape", "Workflows it fits", "What it observes", "What it cannot see", "Ports", "Examples"] as const;
const PATH = "packs/demo/README.md";

interface SectionInput {
  readonly heading: string;
  readonly markdown: string;
  readonly codeSpans: readonly string[];
  readonly codeBlocks: readonly string[];
}
const section = (heading: string, markdown = `About ${heading.toLowerCase()}.`, codeSpans: readonly string[] = [], codeBlocks: readonly string[] = []): SectionInput => ({ heading, markdown, codeSpans, codeBlocks });
const sections = (): SectionInput[] =>
  REQUIRED.map((heading) => {
    if (heading === "Rule shape") return section(heading, "Contribute notes to `notes`.", ["notes"]);
    if (heading === "Ports") return section(heading, "`noteStore` (`NoteStore`): where notes are kept.", ["noteStore", "NoteStore"]);
    if (heading === "Examples") return section(heading, "- `a.config.ts`, with `a.scenarios.ts`: the project keeps a note.", ["a.config.ts", "a.scenarios.ts"]);
    return section(heading);
  });
const input = (overrides: Record<string, unknown> = {}) => ({
  packId: "demo-package/demo",
  path: PATH,
  title: "demo-package/demo: a demonstration pack",
  introduction: { markdown: "A pack for the tests.", codeSpans: [], codeBlocks: [] },
  sections: sections(),
  pointKeys: ["notes"],
  portKeys: ["noteStore"],
  exampleFileNames: ["a.config.ts", "a.scenarios.ts"],
  ...overrides,
});
/** The sections, with Examples naming `codeSpans` and another section, Rule shape, naming `ruleShapeSpans` beside its point key. */
const examplesNaming = (codeSpans: readonly string[], ruleShapeSpans: readonly string[] = []): SectionInput[] =>
  sections().map((given) => {
    if (given.heading === "Examples") return section(given.heading, `- ${codeSpans.map((span) => `\`${span}\``).join(", ")}: the project keeps a note.`, codeSpans);
    if (given.heading === "Rule shape") return section(given.heading, given.markdown, [...given.codeSpans, ...ruleShapeSpans]);
    return given;
  });
const refusal = (raw: Record<string, unknown>): string => {
  const parsed = PackReadme.parse(input(raw));
  return parsed.ok ? "accepted" : parsed.error;
};

describe("PackReadme — a shipped pack's README, by the required sections (ADR 2026-029)", () => {
  test("the summary comes from the title; a wrong title is refused, and so is a missing one", () => {
    const parsed = PackReadme.parse(input());
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.summary).toBe("a demonstration pack");
    for (const title of ["other-package/demo: a demonstration pack", "demo-package/demo", "demo-package/demo:   ", "a demonstration pack"]) {
      const error = refusal({ title });
      expect(error).toContain(PATH);
      expect(error).toContain("# demo-package/demo: ");
    }
    expect(refusal({ title: null })).toContain(PATH);
    expect(refusal({ title: null })).toContain("title");
  });

  test("each missing required section is refused, naming the README, the heading and the fix", () => {
    for (const heading of REQUIRED) {
      const error = refusal({ sections: sections().filter((given) => given.heading !== heading) });
      expect({ heading, names: [error.includes(PATH), error.includes(`## ${heading}`), error.includes("demo-package/demo"), error.includes("add")] }).toEqual({ heading, names: [true, true, true, true] });
    }
  });

  test("a blank section body is refused, and so is a heading given twice", () => {
    const blank = sections().map((given) => (given.heading === "Workflows it fits" ? section(given.heading, "  \n ") : given));
    expect(refusal({ sections: blank })).toContain("## Workflows it fits");
    const twice = [...sections(), section("Examples", "Again.")];
    expect(refusal({ sections: twice })).toContain("## Examples");
    expect(refusal({ sections: twice })).toContain("once");
  });

  test("other sections are kept, in order, beside the required ones", () => {
    const given = [...sections().slice(0, 3), section("Records", "None are kept."), ...sections().slice(3), section("The protection it relies on", "The protected-paths pack.")];
    const parsed = PackReadme.parse(input({ sections: given }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.toJSON().otherSections).toEqual([
      { heading: "Records", markdown: "None are kept." },
      { heading: "The protection it relies on", markdown: "The protected-paths pack." },
    ]);
    expect(parsed.value.toJSON()).toMatchObject({ path: PATH, introduction: "A pack for the tests.", whatItIsFor: "About what it is for.", ruleShape: "Contribute notes to `notes`.", ports: "`noteStore` (`NoteStore`): where notes are kept." });
  });

  test("a point or port key missing from its section's code spans is refused; plain text naming the key does not count", () => {
    const plainPoint = sections().map((given) => (given.heading === "Rule shape" ? section(given.heading, "Contribute notes to notes.") : given));
    const pointError = refusal({ sections: plainPoint });
    expect(pointError).toContain("notes");
    expect(pointError).toContain("## Rule shape");
    const plainPort = sections().map((given) => (given.heading === "Ports" ? section(given.heading, "noteStore: where notes are kept.", ["NoteStore"]) : given));
    const portError = refusal({ sections: plainPort });
    expect(portError).toContain("noteStore");
    expect(portError).toContain("## Ports");
  });

  test("refuses an Examples section that does not name both files of each example, naming the missing one", () => {
    const noScenarios = refusal({ sections: examplesNaming(["a.config.ts"]) });
    expect(noScenarios).toContain(PATH);
    expect(noScenarios).toContain("'a.scenarios.ts'");
    expect(noScenarios).toContain("## Examples");
    const noConfiguration = refusal({ sections: examplesNaming(["a.scenarios.ts"]) });
    expect(noConfiguration).toContain("'a.config.ts'");
    expect(noConfiguration).toContain("## Examples");
    expect(noConfiguration).not.toContain("'a.scenarios.ts'");
  });

  test("refuses a scenarios file in the Examples section that is not in examples/", () => {
    const error = refusal({ sections: examplesNaming(["a.config.ts", "a.scenarios.ts", "b.scenarios.ts"]) });
    expect(error).toContain(PATH);
    expect(error).toContain("'b.scenarios.ts'");
    expect(error).toContain("examples/");
  });

  test("refuses a scenarios file named outside the Examples section", () => {
    const error = refusal({ sections: examplesNaming(["a.config.ts", "a.scenarios.ts"], ["a.scenarios.ts"]) });
    expect(error).toContain(PATH);
    expect(error).toContain("'a.scenarios.ts'");
    expect(error).toContain("## Rule shape");
    expect(refusal({ introduction: { markdown: "See `a.scenarios.ts`.", codeSpans: ["a.scenarios.ts"], codeBlocks: [] } })).toContain("'a.scenarios.ts'");
  });

  test("counts file names only: a path to an example names no file", () => {
    const error = refusal({ sections: examplesNaming(["examples/a.scenarios.ts", "a.config.ts"]) });
    expect(error).toContain("'a.scenarios.ts'");
    expect(error).toContain("'examples/a.scenarios.ts'");
  });

  test("other configuration names are not policed", () => {
    const parsed = PackReadme.parse(input({ sections: examplesNaming(["a.config.ts", "a.scenarios.ts", "bounded.config.ts"], ["bounded.config.ts"]) }));
    expect(parsed.ok ? "accepted" : parsed.error).toBe("accepted");
  });

  test("a README holds no project configuration: a code block calling defineConfig is refused, pointing to the examples", () => {
    const configured = sections().map((given) => (given.heading === "Examples" ? section(given.heading, "See below.", [], ["export default defineConfig({ packs: [demoPack] });"]) : given));
    const error = refusal({ sections: configured });
    expect(error).toContain("## Examples");
    expect(error).toContain("examples/");
  });
});
