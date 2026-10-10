// Every shipped pack's README (src/packs/<name>/README.md, ADR 2026-013's R7)
// has the required sections: its title names the pack's exact id, and its
// seven required headings appear once each, with a body. Its Rule shape
// names every point key and its Ports every port key as inline code, and no
// README holds a project configuration: those are the pack's examples.
// Headings are exact lines outside fenced code.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { prereqs } from "bounded/prereqs";
import { protectedPathsPack } from "bounded/protected-paths";

const PACKS = join(resolve(import.meta.dir, "../.."), "packs");
/** Each shipped pack, by its directory name under src/packs/. */
const SHIPPED_PACKS = new Map<string, { readonly id: { toJSON(): unknown }; readonly points: object; readonly ports: object }>([
  ["prereqs", prereqs],
  ["protected-paths", protectedPathsPack],
]);
const REQUIRED_HEADINGS = ["## What it is for", "## Rule shape", "## Workflows it fits", "## What it observes", "## What it cannot see", "## Ports", "## Examples"];

/** A README's lines, each marked whether it sits inside fenced code. */
function linesOf(text: string): { readonly line: string; readonly fenced: boolean }[] {
  let fence: string | undefined;
  return text.split("\n").map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined && (fence === undefined || (marker[0] === fence[0] && marker.length >= fence.length))) {
      const opened = fence === undefined;
      fence = opened ? marker : undefined;
      return { line, fenced: true };
    }
    return { line, fenced: fence !== undefined };
  });
}

/** The body of a `##` section: its lines up to the next heading of level one or two outside fenced code. */
function sectionBody(text: string, heading: string): string {
  const lines = linesOf(text);
  const start = lines.findIndex(({ line, fenced }) => !fenced && line === heading);
  if (start < 0) return "";
  const end = lines.findIndex(({ line, fenced }, index) => index > start && !fenced && /^#{1,2} /.test(line));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .map(({ line }) => line)
    .join("\n");
}

/** The fenced code blocks of a README, each as its text. */
function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] | undefined;
  for (const { line, fenced } of linesOf(text)) {
    if (fenced && current === undefined) current = [];
    else if (fenced && current !== undefined) current.push(line);
    else if (!fenced && current !== undefined) {
      blocks.push(current.join("\n"));
      current = undefined;
    }
  }
  if (current !== undefined) blocks.push(current.join("\n"));
  return blocks;
}

const inlineCode = (text: string): string[] => [...text.matchAll(/`([^`\n]+)`/g)].map(([, code = ""]) => code);
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

describe("shipped packs' READMEs", () => {
  test("every shipped pack is checked here", () => {
    expect(shippedPackNames.length).toBeGreaterThan(0);
    expect(shippedPackNames).toEqual([...SHIPPED_PACKS.keys()].sort());
  });

  test("each shipped pack's README is titled `# <pack id>: <summary>`", () => {
    expect(SHIPPED_PACKS.size).toBeGreaterThan(0);
    for (const [name, pack] of SHIPPED_PACKS) {
      const title = readmeOf(name).split("\n")[0] ?? "";
      const id = String(pack.id.toJSON());
      expect({ pack: name, titled: title.startsWith(`# ${id}: `) && title.slice(`# ${id}: `.length).trim() !== "" }).toEqual({ pack: name, titled: true });
    }
  });

  test("each shipped pack's README has the seven required sections, each once, with a body", () => {
    expect(SHIPPED_PACKS.size).toBeGreaterThan(0);
    for (const name of SHIPPED_PACKS.keys()) {
      const readme = readmeOf(name);
      const headings = linesOf(readme)
        .filter(({ fenced }) => !fenced)
        .map(({ line }) => line);
      for (const heading of REQUIRED_HEADINGS) {
        expect({ pack: name, heading, count: headings.filter((line) => line === heading).length }).toEqual({ pack: name, heading, count: 1 });
        expect({ pack: name, heading, hasBody: sectionBody(readme, heading).trim() !== "" }).toEqual({ pack: name, heading, hasBody: true });
      }
    }
  });

  test("Rule shape names every point key and Ports every port key in inline code", () => {
    expect(SHIPPED_PACKS.size).toBeGreaterThan(0);
    for (const [name, pack] of SHIPPED_PACKS) {
      const readme = readmeOf(name);
      const ruleShapeCode = inlineCode(sectionBody(readme, "## Rule shape"));
      const portsCode = inlineCode(sectionBody(readme, "## Ports"));
      for (const point of Object.keys(pack.points)) expect({ pack: name, point, named: ruleShapeCode.includes(point) }).toEqual({ pack: name, point, named: true });
      for (const port of Object.keys(pack.ports)) expect({ pack: name, port, named: portsCode.includes(port) }).toEqual({ pack: name, port, named: true });
    }
  });

  test("no README holds a project configuration", () => {
    expect(SHIPPED_PACKS.size).toBeGreaterThan(0);
    for (const name of SHIPPED_PACKS.keys()) {
      const readme = readmeOf(name);
      expect(readme).not.toBe("");
      expect({ pack: name, configurations: fencedBlocks(readme).filter((block) => block.includes("defineConfig(")) }).toEqual({ pack: name, configurations: [] });
    }
  });
});
