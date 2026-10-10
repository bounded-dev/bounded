import { describe, expect, test } from "bun:test";
import type { MarkdownSections } from "./build-package-catalog.contract.ts";

/** The MarkdownSections under test, and a package it resolves its library from. */
export interface MarkdownSectionsFixture {
  readonly sections: MarkdownSections;
  readonly packageDir: string;
}

const README = [
  "# demo-package/demo: a demonstration pack",
  "",
  "An introduction naming `intro`.",
  "",
  "## What it is for",
  "",
  "Keeping notes in `notes`, and *`emphasised`* ones.",
  "",
  "```ts",
  "## Not a heading",
  "const inFence = `not a span`;",
  "```",
  "",
  "### A subsection",
  "",
  "Still the same section, with `deeper`.",
  "",
  "## Ports",
  "",
  "- `noteStore` (`NoteStore`): where notes are kept.",
  "",
].join("\n");

/** The behaviour every MarkdownSections must have. */
export function markdownSectionsConformance(name: string, fixture: () => Promise<MarkdownSectionsFixture>): void {
  describe(`${name} conforms to MarkdownSections`, () => {
    test("gives the title, the introduction, and each section's heading, body and inline code spans", async () => {
      const given = await fixture();
      const read = await given.sections.read(given.packageDir, README);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.title).toBe("demo-package/demo: a demonstration pack");
      expect(read.value.introduction).toEqual({ markdown: "An introduction naming `intro`.", codeSpans: ["intro"], codeBlocks: [] });
      expect(read.value.sections.map(({ heading, level }) => ({ heading, level }))).toEqual([
        { heading: "What it is for", level: 2 },
        { heading: "Ports", level: 2 },
      ]);
      expect(read.value.sections[0]?.markdown).toStartWith("Keeping notes in `notes`");
      expect(read.value.sections[0]?.markdown).toContain("### A subsection");
      expect(read.value.sections[0]?.markdown).toEndWith("Still the same section, with `deeper`.");
      expect(read.value.sections[0]?.codeSpans).toEqual(["notes", "emphasised", "deeper"]);
      expect(read.value.sections[1]).toEqual({ heading: "Ports", level: 2, markdown: "- `noteStore` (`NoteStore`): where notes are kept.", codeSpans: ["noteStore", "NoteStore"], codeBlocks: [] });
    });

    test("ignores `## ` inside a fenced block, and gives the block as code", async () => {
      const given = await fixture();
      const read = await given.sections.read(given.packageDir, README);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.sections.map(({ heading }) => heading)).not.toContain("Not a heading");
      expect(read.value.sections[0]?.codeBlocks).toEqual(["## Not a heading\nconst inFence = `not a span`;"]);
    });

    test("takes no code span from inside a fenced block", async () => {
      const given = await fixture();
      const read = await given.sections.read(given.packageDir, README);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.sections.flatMap(({ codeSpans }) => codeSpans)).not.toContain("not a span");
    });

    test("a document without a title has none; a second level-one heading starts a section of level 1", async () => {
      const given = await fixture();
      const read = await given.sections.read(given.packageDir, "Text first.\n\n# Late title\n\nBody.\n");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.title).toBeNull();
      expect(read.value.introduction.markdown).toBe("Text first.");
      expect(read.value.sections).toEqual([{ heading: "Late title", level: 1, markdown: "Body.", codeSpans: [], codeBlocks: [] }]);
    });
  });
}
