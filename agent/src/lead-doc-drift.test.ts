import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LEAD_COMMANDS, parseLeadArgs } from "./lead-commands.ts";
import { LEAD_COMMAND_TOOLS } from "./lead-policy.ts";
import { SETUP_COMMAND } from "./setup-state.ts";
import { LEAD_REPLAN_USAGE } from "./init-command.ts";
import { BOARD_STATUSES } from "./tracker.ts";

// The lead's commands are typed by people and agents from the docs; a doc that
// drifts from the parser teaches a command that is refused (ADR 2026-066).
// The team-lead skill is held to every command exactly, to every pi tool that
// carries one, and to the board's statuses; the READMEs to the commands they
// teach. No doc may teach a command the parser no longer accepts.

const agent = join(import.meta.dirname, "..");
const SKILL = join(agent, "skills", "team-lead", "SKILL.md");
const DOCS = [join(agent, "..", "README.md"), join(agent, "hosts", "claude-code", "README.md"), SKILL];
const flat = (path: string): string => readFileSync(path, "utf8").replace(/\s*\n\s*/g, " ");

describe("the team-lead skill matches the lead's commands", () => {
  test.each(LEAD_COMMANDS.map((c) => [c.name, c.usage] as const))("it spells `%s` exactly as the parser accepts it", (_name, usage) => {
    expect(flat(SKILL)).toContain(usage);
  });

  test("it names the pi tool for every command", () => {
    for (const tool of Object.values(LEAD_COMMAND_TOOLS)) expect(flat(SKILL)).toContain(`\`${tool}\``);
  });

  test("it names every board status, in order", () => {
    const text = flat(SKILL);
    const positions = BOARD_STATUSES.map((status) => text.indexOf(`| ${status} |`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("every `bounded lead` command the skill shows is one the parser accepts", () => {
    const shown = [...readFileSync(SKILL, "utf8").matchAll(/`bounded lead ([^`<\[]+?)`/g)].map((m) => m[1]!.trim());
    for (const command of shown.filter((c) => c !== "")) {
      const name = command.split(" ")[0] === "ticket" ? "ticket" : command.split(" ")[0]!;
      expect(LEAD_COMMANDS.some((c) => c.name.startsWith(name)), command).toBe(true);
    }
    expect(parseLeadArgs(["prepare"]).ok).toBe(false);
  });
});

describe("lead commands in the docs match the code", () => {
  test.each(DOCS)("%s names the setup and start commands exactly, and no retired command", (doc) => {
    const text = flat(doc);
    expect(text).toContain(SETUP_COMMAND);
    expect(text).toContain("bounded lead start <issue>");
    expect(text).not.toMatch(/bounded lead (prepare|release)/);
  });

  // Re-planning before the first ticket (ADR 2026-065) is the lead's too.
  test.each(DOCS.slice(1))("%s names the re-plan command exactly", (doc) => {
    expect(flat(doc)).toContain(LEAD_REPLAN_USAGE);
  });
});
