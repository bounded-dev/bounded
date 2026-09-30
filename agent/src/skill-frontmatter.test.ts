import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// A skill with malformed frontmatter does not error — it silently DISAPPEARS
// from the session's skill list, and the agent then reconstructs the workflow
// from memory. That is what happened on 2026-09-02: the `developer-stage`
// description was reworded to
//
//     Runs the developer stage (TN-26-001): you design it and drive it...
//
// and the ": " inside an unquoted YAML scalar broke the block. pi dropped the
// skill. The file looked perfect, nothing logged a warning, and a live dogfood
// arm ran the whole way through without its pipeline — the agent hunting for a
// skill that was not there and improvising the gates from memory.
//
// The failure is invisible by construction, so it needs a test rather than
// care. This one validates every skill in the harness, not just that one.

const SKILLS_ROOT = fileURLToPath(new URL("../skills", import.meta.url));
const PACKS_ROOT = fileURLToPath(new URL("../packs", import.meta.url));

/**
 * Every installed pack's `skills/` directory.
 *
 * This used to be the single literal `packs/ts/skills`, which was correct for
 * exactly as long as one pack existed. A second pack's skill would then have
 * been validated by nothing — and the failure this whole file exists to catch
 * is the SILENT one, where a malformed frontmatter block makes a skill vanish
 * from the session list with no warning anywhere. The walk finds the packs
 * instead of naming them, so pack number three is covered on the day it lands.
 */
function packSkillRoots(): string[] {
  try {
    return readdirSync(PACKS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(PACKS_ROOT, e.name, "skills"))
      .sort();
  } catch {
    return [];
  }
}

function skillFiles(root: string): { name: string; path: string }[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: { name: string; path: string }[] = [];
  for (const entry of entries) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const path = join(dir, "SKILL.md");
    try {
      statSync(path);
      out.push({ name: entry, path });
    } catch {
      // a directory without a SKILL.md is not a skill
    }
  }
  return out;
}

const SKILLS = [
  ...skillFiles(SKILLS_ROOT),
  ...packSkillRoots().flatMap((root) => skillFiles(root)),
];

/** The frontmatter block between the first two `---` fences. */
function frontmatter(source: string): string {
  const lines = source.split(/\r?\n/);
  const fences: number[] = [];
  for (let i = 0; i < lines.length && fences.length < 2; i++) {
    if (lines[i]?.trim() === "---") fences.push(i);
  }
  if (fences.length < 2) throw new Error("no frontmatter block");
  return lines.slice(fences[0]! + 1, fences[1]!).join("\n");
}

/** Top-level `key: value` pairs, treating an indented line as a continuation. */
function fields(fm: string): Map<string, string> {
  const out = new Map<string, string>();
  let key: string | undefined;
  for (const line of fm.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (m && !/^\s/.test(line)) {
      key = m[1]!;
      out.set(key, (m[2] ?? "").trim());
    } else if (key !== undefined) {
      out.set(key, `${out.get(key) ?? ""} ${line.trim()}`);
    }
  }
  return out;
}

/**
 * Is this a YAML plain (unquoted) scalar that YAML will actually accept?
 *
 * The rule that bit us: in a plain scalar, ": " ends the key — so any ": "
 * inside an unquoted value makes the line ambiguous and the parse fails. The
 * same is true of a trailing " #", which starts a comment.
 */
function plainScalarIsSafe(value: string): boolean {
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  if (quoted) return true;
  return !value.includes(": ") && !value.includes(" #") && !value.endsWith(":");
}

describe("skill frontmatter", () => {
  test("there are skills to check (the walk itself works)", () => {
    expect(SKILLS.length).toBeGreaterThan(5);
  });

  // The walk finds packs rather than naming them, so it has to be shown
  // actually reaching past the first one — otherwise a regression to a single
  // hard-coded root would pass every test above it.
  test("every pack's skills are in the walk, not just the first pack's", () => {
    const names = SKILLS.map((s) => s.name);
    expect(names).toContain("ts-api-service");
    expect(names).toContain("ts-web-app");
  });

  test("service guidance belongs to the optional service capability", () => {
    expect(skillFiles(join(PACKS_ROOT, "ts", "skills")).map((s) => s.name)).not.toContain("ts-api-service");
    expect(skillFiles(join(PACKS_ROOT, "ts-trpc", "skills")).map((s) => s.name)).toContain("ts-api-service");
  });

  for (const { name, path } of SKILLS) {
    describe(name, () => {
      const source = readFileSync(path, "utf8");

      test("has a frontmatter block", () => {
        expect(() => frontmatter(source)).not.toThrow();
      });

      test("declares name and description", () => {
        const f = fields(frontmatter(source));
        expect(f.get("name"), "missing `name:`").toBeTruthy();
        expect(f.get("description"), "missing `description:`").toBeTruthy();
      });

      test("name matches its directory — pi finds skills by folder", () => {
        expect(fields(frontmatter(source)).get("name")).toBe(name);
      });

      // The one that would have caught 2026-09-02.
      test("every value is a parseable YAML scalar (no bare ': ' in a value)", () => {
        for (const [key, value] of fields(frontmatter(source))) {
          expect(
            plainScalarIsSafe(value),
            `${name}: \`${key}\` contains ": ", " #", or a trailing ":" while unquoted. ` +
              `YAML will not parse it and pi will silently drop this skill. ` +
              `Reword it, or wrap the whole value in double quotes.`,
          ).toBe(true);
        }
      });
    });
  }
});
