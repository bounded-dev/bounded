// Every shipped pack's README (src/packs/<name>/README.md, ADR 2026-013's R7)
// has the required sections: its title names the pack's exact id, and its
// seven required headings appear once each, with a body. Its Rule shape
// names every point key and its Ports every port key as inline code, and no
// README holds a project configuration: those are the pack's examples.
// Each README is read as the package catalogue build reads it (ADR 2026-026):
// split into sections by the build's own Markdown reader, MarkedMarkdownSections,
// and checked by its own rules, PackReadme.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MarkedMarkdownSections } from "bounded/adapters";
import { PackDescription, PackReadme } from "bounded/domain";
import { prereqs } from "bounded/prereqs";
import { protectedPathsPack } from "bounded/protected-paths";

/** bounded's directory, src/: the package the catalogue build reads, and resolves marked from. */
const BOUNDED = resolve(import.meta.dir, "../..");
const PACKS = join(BOUNDED, "packs");
/** Each shipped pack, by its directory name under src/packs/. */
const SHIPPED_PACKS = new Map<string, { readonly id: { toJSON(): unknown }; readonly points: object; readonly ports: object }>([
  ["prereqs", prereqs],
  ["protected-paths", protectedPathsPack],
]);
const REQUIRED_HEADINGS = ["What it is for", "Rule shape", "Workflows it fits", "What it observes", "What it cannot see", "Ports", "Examples"];
const sections = new MarkedMarkdownSections();

const shippedPackNames = readdirSync(PACKS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const readmeOf = (name: string): string => {
  try {
    return readFileSync(join(PACKS, name, "README.md"), "utf8");
  } catch {
    return "";
  }
};
const packs = { prereqs, "protected-paths": protectedPathsPack } as const;
/** A shipped pack's README, read by the build's Markdown reader; it throws when the reader refuses. */
async function documentOf(name: string) {
  const read = await sections.read(BOUNDED, readmeOf(name));
  if (!read.ok) throw new Error(`${name}'s README cannot be read: ${read.error}`);
  return read.value;
}
/** What the build gives PackReadme for a shipped pack. */
async function readmeInputOf(name: keyof typeof packs) {
  const description = PackDescription.of(packs[name]);
  const document = await documentOf(name);
  return {
    packId: description.id,
    path: `packs/${name}/README.md`,
    title: document.title,
    introduction: document.introduction,
    sections: document.sections,
    pointKeys: description.points.map(({ key }) => key),
    portKeys: description.ports.map(({ key }) => key),
  };
}
const shippedNames = (): (keyof typeof packs)[] => [...SHIPPED_PACKS.keys()].filter((name): name is keyof typeof packs => name in packs);

describe("shipped packs' READMEs", () => {
  test("every shipped pack is checked here", () => {
    expect(shippedPackNames.length).toBeGreaterThan(0);
    expect(shippedPackNames).toEqual([...SHIPPED_PACKS.keys()].sort());
  });

  test("each shipped pack's README parses with the build's own rules", async () => {
    expect(SHIPPED_PACKS.size).toBeGreaterThan(0);
    expect(shippedNames()).toEqual([...SHIPPED_PACKS.keys()]);
    for (const name of shippedNames()) {
      const parsed = PackReadme.parse(await readmeInputOf(name));
      expect({ pack: name, error: parsed.ok ? null : parsed.error }).toEqual({ pack: name, error: null });
      const headings = (await documentOf(name)).sections.map(({ heading }) => heading);
      for (const heading of REQUIRED_HEADINGS) expect({ pack: name, heading, count: headings.filter((given) => given === heading).length }).toEqual({ pack: name, heading, count: 1 });
    }
  });

  test("each README's summary is its title's", async () => {
    expect(SHIPPED_PACKS.size).toBeGreaterThan(0);
    for (const name of shippedNames()) {
      const parsed = PackReadme.parse(await readmeInputOf(name));
      const title = readmeOf(name).split("\n")[0] ?? "";
      const id = String(packs[name].id.toJSON());
      expect({ pack: name, titled: title.startsWith(`# ${id}: `) }).toEqual({ pack: name, titled: true });
      expect({ pack: name, summary: parsed.ok ? parsed.value.summary : parsed.error }).toEqual({ pack: name, summary: title.slice(`# ${id}: `.length).trim() });
    }
  });

  test("Rule shape and Ports name every key as inline code, by the lexer's code spans", async () => {
    expect(SHIPPED_PACKS.size).toBeGreaterThan(0);
    for (const name of shippedNames()) {
      const document = await documentOf(name);
      const codeSpansOf = (heading: string): readonly string[] => document.sections.find((section) => section.heading === heading)?.codeSpans ?? [];
      const description = PackDescription.of(packs[name]);
      expect(description.points.length + description.ports.length).toBeGreaterThan(0);
      for (const { key } of description.points) expect({ pack: name, point: key, named: codeSpansOf("Rule shape").includes(key) }).toEqual({ pack: name, point: key, named: true });
      for (const { key } of description.ports) expect({ pack: name, port: key, named: codeSpansOf("Ports").includes(key) }).toEqual({ pack: name, port: key, named: true });
    }
  });

  test("no README holds a project configuration, by the lexer's fenced code blocks", async () => {
    expect(SHIPPED_PACKS.size).toBeGreaterThan(0);
    for (const name of shippedNames()) {
      const document = await documentOf(name);
      expect(readmeOf(name)).not.toBe("");
      const blocks = [...document.introduction.codeBlocks, ...document.sections.flatMap((section) => section.codeBlocks)];
      expect({ pack: name, configurations: blocks.filter((block) => block.includes("defineConfig(")) }).toEqual({ pack: name, configurations: [] });
      expect({ pack: name, sectionsRead: document.sections.length >= REQUIRED_HEADINGS.length }).toEqual({ pack: name, sectionsRead: true });
    }
  });
});
