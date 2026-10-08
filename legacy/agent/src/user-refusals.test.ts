import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { configDriftBlock, configDriftReason } from "../packs/ts/scripts/project-config.ts";
import { commandsIn, constantStrings, harnessSources, stringTexts, userCommandViolations } from "../test/fixtures/user-steps.ts";
import { ghFailure, gitHubSignInError } from "../trackers/github.ts";
import { trackerRaw, trackerRefusal } from "./tracker.ts";

// "A project's user never runs harness steps" (AGENTS.md; ADR LEG-2026-072), held
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

  // Final review of #52, major 2 and minor 4: the detector reads composed
  // messages whole, every line of an output routed to the user, the
  // harness's own command shapes, and a sentence pointing back at the user.
  test("the detector reads what it used to miss", () => {
    expect(userCommandViolations("x", "the check failed — route → user\n  fix: `bun run check` in the project", () => false, true).map((v) => v.command))
      .toEqual(["bun run check"]);
    expect(commandsIn("the user restores it with `.bounded/harness/scripts/bounded sync-config`").length).toBe(1);
    expect(commandsIn("the user restores it with `sync-config`")).toEqual(["sync-config"]);
    expect(commandsIn("the user reruns `green_gate` once it is up")).toEqual(["green_gate"]);
    expect(userCommandViolations("x", "Tell the user the config drifted. They restore it with `sync-config`.").map((v) => v.command))
      .toEqual(["sync-config"]);
    expect(commandsIn("the user may run `bounded lead release 4 --force`")).toEqual([]);
  });

  test("a tracker refusal for missing GitHub sign-in names only the reserved sign-in, and why", () => {
    const refusal = trackerRefusal(gitHubSignInError());
    expect(refusal).toMatch(/route → user/);
    expect(userCommandViolations("trackerRefusal", refusal, () => false, true)).toEqual([]);
    expect(refusal).toContain("gh auth login");
    expect(refusal).toMatch(/credentials/);
  });

  // Re-review of #52, major: raw `gh` output reached the user through the
  // tracker refusal. Known failures map to product terms; the raw text stays
  // out of the routed message (the guard log's detail keeps it).
  test.each([
    ["the reviewer's repro: a missing scope", "error: your authentication token is missing required scopes [project]\nTo request it, run:  gh auth refresh -s project"],
    ["an expired sign-in", "HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login"],
    ["a board that is gone", "GraphQL: Could not resolve to a ProjectV2 with the number 9. (organization.projectV2)"],
    ["no network", "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com"],
    ["anything else", "something odd happened: run `gh repo sync` and try again"],
  ])("a tracker refusal for %s names no command but a reserved one, and none of gh's own text", (_label, stderr) => {
    const error = ghFailure(["project", "item-edit"], stderr);
    const refusal = trackerRefusal(error);
    expect(refusal).toMatch(/route → user/);
    expect(userCommandViolations("trackerRefusal", refusal, () => false, true)).toEqual([]);
    for (const line of stderr.split("\n")) expect(refusal).not.toContain(line.trim());
    expect(trackerRaw(error)).toContain(stderr.split("\n")[0]!.trim());
  });

  test("a missing project scope asks the user for the one reserved refresh, with its why", () => {
    const refusal = trackerRefusal(ghFailure(["project", "item-edit"], "missing required scopes [project]; run: gh auth refresh -s project"));
    expect(refusal).toContain("the GitHub sign-in needs project access");
    expect(refusal).toContain("`gh auth refresh -s project`");
    expect(refusal).toMatch(/credentials/);
  });

  test("every source string routed to the user names no command, every line read as the user's", () => {
    const sources = harnessSources(agent);
    const constants = constantStrings(sources);
    const violations = sources.flatMap(({ path, source }) => stringTexts(path, source, constants)
      .filter((text) => /route → user/.test(text))
      .flatMap((text) => userCommandViolations(path, text, namesGenerationAsGap, true)));
    expect(violations).toEqual([]);
  });

  test("the reserved GitHub sign-in names its why wherever the user is sent to it", () => {
    const sources = harnessSources(agent);
    const constants = constantStrings(sources);
    const named = sources.flatMap(({ path, source }) => stringTexts(path, source, constants)
      .filter((text) => text.includes("gh auth login") && /\buser\b/i.test(text)).map((text) => ({ path, text })));
    expect(named.length).toBeGreaterThan(0);
    for (const { path, text } of named) expect(text, path).toMatch(/credentials/);
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
