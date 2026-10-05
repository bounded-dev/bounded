import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { configDriftBlock, configDriftReason } from "../packs/ts/scripts/project-config.ts";
import { constantStrings, harnessSources, stringTexts, userCommandViolations } from "../test/fixtures/user-steps.ts";

// "A project's user never runs harness steps" (AGENTS.md; ADR 2026-072), held
// over what the harness itself says: the refusals routed to a person, and
// every string in the harness's own source that addresses the user. Only the
// reserved recovery commands may be named, each with why; the one other
// exception is the #57 sentence naming an ambiguous schema change, which says
// it is a temporary harness gap.

const agent = join(import.meta.dirname, "..");
const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { vi.stubEnv("BOUNDED_GUARD_LOG", "off"); return () => vi.unstubAllEnvs(); });

/** A project whose config the packs generated, but whose composition is unreadable. */
function drifted(): string {
  const dir = mkdtempSync(join(tmpdir(), "user-refusals-"));
  temporary.push(dir);
  mkdirSync(join(dir, ".bounded"), { recursive: true });
  writeFileSync(join(dir, ".bounded/installation.json"), "{}\n");
  return dir;
}

/** The #57 exception: a sentence naming the generation command that says it is temporary. */
const namesGenerationAsGap = (sentence: string): boolean => sentence.includes("db:generate") && sentence.includes("(#57)");

describe("refusals routed to a person name no command for the user (issue #52)", () => {
  test("the config-drift block names no command for the user and routes to the team lead", () => {
    const block = configDriftBlock("deliver", drifted());
    expect(block).toBeDefined();
    const violations = block!.lines.flatMap((line) => userCommandViolations("configDriftBlock", line));
    expect(violations).toEqual([]);
    expect(block!.lines.join("\n")).toMatch(/team lead/);
  });

  test("the spawning primitives' drift reason does the same", () => {
    const reason = configDriftReason(drifted());
    expect(reason).toBeDefined();
    expect(userCommandViolations("configDriftReason", reason!)).toEqual([]);
    expect(reason).toMatch(/team lead/);
  });

  test("no source string routes a step to the user by naming a command", () => {
    const sources = harnessSources(agent);
    const constants = constantStrings(sources);
    const violations = sources.flatMap(({ path, source }) =>
      stringTexts(path, source, constants).flatMap((text) => userCommandViolations(path, text, namesGenerationAsGap)));
    expect(violations).toEqual([]);
  });

  test("comments are not scanned", () => {
    expect(stringTexts("x.ts", "// tell the user to run bun run x\nconst a = 1;\n").flatMap((t) => userCommandViolations("x.ts", t))).toEqual([]);
    const literal = stringTexts("x.ts", 'const a = "tell the user to run bun run x";\n').flatMap((t) => userCommandViolations("x.ts", t));
    expect(literal).toHaveLength(1);
    expect(literal[0]!.command).toBe("bun run x");
    // A sentence split across literals is read whole.
    const split = stringTexts("x.ts", 'const a = "tell the user " + "to run `git pull` first";\n').flatMap((t) => userCommandViolations("x.ts", t));
    expect(split.map((v) => v.command)).toEqual(["git pull"]);
  });

  test("every reserved command named for the user says why", () => {
    const sources = harnessSources(agent);
    const constants = constantStrings(sources);
    const named = sources.flatMap(({ path, source }) => stringTexts(path, source, constants)
      .filter((text) => text.includes("bounded lead release") && /\buser\b/i.test(text))
      .map((text) => ({ path, text })));
    expect(named.length).toBeGreaterThan(0);
    for (const { path, text } of named) expect(text, path).toMatch(/cannot prove|cannot tell/);
  });
});
