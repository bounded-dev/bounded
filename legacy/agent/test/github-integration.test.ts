// Opt-in: the GitHub tracker adapter against a real scratch repository
// (ADR 2026-066). Skipped unless BOUNDED_GITHUB_IT_REPO names a scratch
// repository (owner/name) the authenticated `gh` may write to, and
// BOUNDED_GITHUB_IT_PROJECT names its Projects board (owner/number) whose
// Status field has exactly the harness's six statuses. It creates one issue,
// walks it across the board, labels, comments on and closes it. Never point
// it at a repository whose issues matter.
//
//   BOUNDED_GITHUB_IT_REPO=me/scratch BOUNDED_GITHUB_IT_PROJECT=me/3 npx vitest run test/github-integration.test.ts

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { BOARD_STATUSES } from "../src/tracker.ts";
import { gitHubSettings, gitHubTracker, resolveGitHubAtInit } from "../trackers/github.ts";

const REPO = process.env["BOUNDED_GITHUB_IT_REPO"];
const PROJECT = process.env["BOUNDED_GITHUB_IT_PROJECT"];
/** Repositories this test must never write to. */
const PROTECTED = new Set(["bounded-dev/the-bounded-harness"]);

describe.skipIf(REPO === undefined || PROJECT === undefined)("GitHub tracker against a scratch repository", () => {
  test("init resolves the board; an issue walks every status, takes and loses a label, and closes", () => {
    if (PROTECTED.has(REPO!.toLowerCase())) throw new Error(`${REPO} is not a scratch repository`);
    const clone = mkdtempSync(join(tmpdir(), "bounded-gh-it-"));
    try {
      execFileSync("git", ["init", "-q", clone]);
      execFileSync("git", ["remote", "add", "origin", `https://github.com/${REPO}.git`], { cwd: clone });
      const config = resolveGitHubAtInit(clone, PROJECT);
      expect(config.repository.toLowerCase()).toBe(REPO!.toLowerCase());
      const tracker = gitHubTracker(gitHubSettings(config as unknown as Record<string, unknown>));
      tracker.check();
      const { number } = tracker.createIssue(`Bounded integration test ${new Date().toISOString()}`, "## Outcome\n\nScratch.\n");
      try {
        for (const status of BOARD_STATUSES) {
          tracker.setStatus(number, status);
          expect(tracker.viewIssue(number).status).toBe(status);
        }
        tracker.addLabel(number, "blocked: builder");
        expect(tracker.viewIssue(number).labels).toContain("blocked: builder");
        expect(tracker.issuesWithLabel("blocked: builder")).toContain(number);
        tracker.removeLabel(number, "blocked: builder");
        expect(tracker.viewIssue(number).labels).not.toContain("blocked: builder");
        tracker.comment(number, "`design-gate`: PASS — integration test");
      } finally {
        tracker.close(number);
      }
      expect(tracker.viewIssue(number).state).toBe("closed");
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  }, 120_000);
});
