import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LEAD_PREPARE_USAGE } from "./lead-run.ts";
import { SETUP_COMMAND } from "./setup-state.ts";

// The lead's two run-control commands are typed by people and agents from the
// docs; a doc that drifts from the parser teaches a command that is refused.
// Each doc that tells the lead or a user how to prepare a run or install
// dependencies must spell both commands exactly as the code accepts them.

const agent = join(import.meta.dirname, "..");
const DOCS = [
  join(agent, "..", "README.md"),
  join(agent, "hosts", "claude-code", "README.md"),
  join(agent, "skills", "team-lead", "SKILL.md"),
];

describe("lead commands in the docs match the code", () => {
  test.each(DOCS)("%s names the run-preparation and setup commands exactly", (doc) => {
    const text = readFileSync(doc, "utf8");
    expect(text).toContain(LEAD_PREPARE_USAGE);
    expect(text).toContain(SETUP_COMMAND);
  });
});
