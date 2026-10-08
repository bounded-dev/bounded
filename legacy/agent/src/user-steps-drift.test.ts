import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import {
  constantStrings, filesUnder, harnessSources, RESERVED, section, sentences, stringTexts, userCommandViolations, withoutSection,
} from "../test/fixtures/user-steps.ts";
import { USER_RECOVERY_COMMANDS } from "./lead-policy.ts";

// "A project's user never runs harness steps" (AGENTS.md; ADR 2026-072), held
// over everything a harnessed project's seats load: no role brief or skill
// tells the user to run a command, except the reserved recovery commands and
// two named, temporary exceptions, each a known harness gap that says so:
//
//   #54  the team-lead's "Release a dependency" section (the handoff commands)
//   #57  naming an ambiguous schema change (`db:generate`), until the harness
//        runs the generation with the user's answer to "renamed or new?"
//
// The detector itself is test/fixtures/user-steps.ts, shared with the
// refusal test over the harness's own source strings.

const agent = join(import.meta.dirname, "..");
const TEAM_LEAD = join(agent, "skills", "team-lead", "SKILL.md");
const DEVELOPER_STAGE = join(agent, "skills", "developer-stage", "SKILL.md");
const DRIZZLE_SKILL = join(agent, "packs", "ts-drizzle-postgres", "skills", "ts-drizzle-postgres", "SKILL.md");
const CHECK_DB = join(agent, "packs", "ts-drizzle-postgres", "scripts", "check-db.ts");
/** The #54 exception, by its heading. */
const DEPENDENCY_SECTION = "## Release a dependency";
/** The #57 exception: a sentence naming the generation command. */
const namesGeneration = (sentence: string): boolean => sentence.includes("db:generate");

const markdown = (path: string): boolean => path.endsWith(".md");

/** Every role brief and skill a harnessed project loads. */
function docs(): string[] {
  const packs = join(agent, "packs");
  return [
    ...readdirSync(join(agent, "agents")).filter(markdown).sort().map((name) => join(agent, "agents", name)),
    ...filesUnder(join(agent, "skills", "team-lead"), markdown),
    ...filesUnder(join(agent, "skills", "developer-stage"), markdown),
    ...readdirSync(packs).sort().flatMap((pack) => {
      try {
        return filesUnder(join(packs, pack, "skills"), markdown);
      } catch {
        return [];
      }
    }),
  ];
}

/** A doc as the scan reads it: the team lead's #54 section set aside. */
const docText = (path: string): string => {
  const text = readFileSync(path, "utf8");
  return path === TEAM_LEAD ? withoutSection(text, DEPENDENCY_SECTION) : text;
};
const flat = (path: string): string => readFileSync(path, "utf8").replace(/\s*\n\s*/g, " ");

describe("no role brief or skill hands the user a harness step (issue #52)", () => {
  test("the reserved list is the core's", () => {
    expect(RESERVED).toEqual(USER_RECOVERY_COMMANDS);
  });

  test("no role brief or skill a harnessed project loads tells the user to run a command", () => {
    const violations = docs().flatMap((path) => userCommandViolations(relative(agent, path), docText(path), namesGeneration));
    expect(violations).toEqual([]);
  });

  test("the two exceptions say plainly that they are temporary harness gaps", () => {
    expect(section(readFileSync(TEAM_LEAD, "utf8"), DEPENDENCY_SECTION).replace(/\s*\n\s*/g, " "))
      .toMatch(/temporarily the user's: it is a known harness gap \(#54\)/);
    const skill = sentences(readFileSync(DRIZZLE_SKILL, "utf8")).filter(namesGeneration);
    const source = stringTexts(CHECK_DB, readFileSync(CHECK_DB, "utf8")).flatMap(sentences).filter(namesGeneration);
    expect(skill.length).toBeGreaterThan(0);
    expect(source.length).toBeGreaterThan(0);
    for (const sentence of [...skill, ...source]) {
      expect(sentence).toContain("temporarily the user's");
      expect(sentence).toContain("(#57)");
    }
  });

  test("no brief, skill or refusal sends anyone to .env, db:up or db:migrate for a check or a test", () => {
    const sources = harnessSources(agent);
    const constants = constantStrings(sources);
    const texts = [
      ...docs().map((path) => ({ where: relative(agent, path), text: readFileSync(path, "utf8") })),
      ...sources.flatMap(({ path, source }) => stringTexts(path, source, constants).map((text) => ({ where: path, text }))),
    ];
    const sends = texts.flatMap(({ where, text }) => sentences(text)
      // `.env` itself, not `.env.example`; a check or a test, not `check-db.ts`.
      .filter((s) => /\.env(?![\w.])|db:up|db:migrate/.test(s))
      .filter((s) => /\b(test|tests|check|green|deliver|merge)\b(?![-:.\w])/i.test(s) || /\buser\b/i.test(s))
      .filter((s) => !/\b(never|not|no|without)\b/i.test(s))
      .map((sentence) => ({ where, sentence })));
    expect(sends).toEqual([]);
  });

  test("the scan is not empty", () => {
    const all = docs();
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(harnessSources(agent).length).toBeGreaterThanOrEqual(20);
    expect(all.flatMap((path) => sentences(docText(path))).some((s) => /\buser\b/i.test(s))).toBe(true);
  });
});

describe("the team lead's own guidance (issue #52)", () => {
  test("the team lead reports a dead end as a harness bug", () => {
    expect(flat(TEAM_LEAD)).toContain(
      "If you find you have no legal move, tell the user in product terms that the harness cannot finish this step on its own " +
        "and that this is a harness bug; never offer a workaround that hands the user a step, such as a command to type.",
    );
  });

  test("the lead runs sync-config in a ticket's worktree, only after the user agrees", () => {
    const text = flat(TEAM_LEAD);
    expect(text).toContain("bounded lead sync-config <issue>");
    expect(text).toContain("`lead_sync_config`");
    expect(text).toMatch(/only after the user (explicitly )?agrees/);
  });

  test("a main behind origin is the lead's to bring level", () => {
    const text = flat(TEAM_LEAD);
    expect(text).not.toMatch(/user's to bring level/);
    expect(text).toMatch(/fast-forward/i);
  });

  test("the architect is told what route → user means", () => {
    const stage = readFileSync(DEVELOPER_STAGE, "utf8");
    expect(stage).toContain("orchestrator | user");
    expect(stage).toMatch(/route → user/);
    expect(flat(DEVELOPER_STAGE)).toMatch(/report.*team lead.*product terms/i);
  });
});
