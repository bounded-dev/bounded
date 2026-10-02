import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BOARD_STATUSES } from "../src/tracker.ts";
import { ghCommandLine, ghExecutable, gitHubSettings, gitHubTracker, parseProjectRef, resolveGitHubAtInit, type GhRun } from "./github.ts";
import { openTracker, trackerConfigAtInit } from "./index.ts";

// The GitHub adapter (ADR 2026-066), driven through a fake `gh` command line:
// the same spawn path as production, never the network.

const FAKE_GH = join(import.meta.dirname, "..", "test", "support", "fake-gh.mjs");
let dir = "";
let statePath = "";
const state = (): Record<string, unknown> & { calls: string[][]; issues: Record<string, Record<string, unknown>> } =>
  JSON.parse(readFileSync(statePath, "utf8"));
const seed = (value: Readonly<Record<string, unknown>>): void => writeFileSync(statePath, JSON.stringify(value));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bounded-gh-"));
  statePath = join(dir, "gh.json");
  seed({});
  vi.stubEnv("FAKE_GH_STATE", statePath);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const gh = (): GhRun => ghCommandLine(FAKE_GH);
const settings = () => gitHubSettings(resolveGitHubAtInit(dir, undefined, gh()) as unknown as Record<string, unknown>);

describe("init: GitHub is required", () => {
  test("an authenticated gh, a repository and a board with exactly the statuses give the tracker config", () => {
    const config = resolveGitHubAtInit(dir, undefined, gh());
    expect(config).toMatchObject({
      kind: "github", repository: "acme/shop",
      project: { owner: "acme", number: 1, id: "PVT_1", title: "Shop", statusFieldId: "F_status" },
    });
    expect(Object.keys(config.project.options)).toEqual([...BOARD_STATUSES]);
  });

  test.each([
    [{ unauthenticated: true }, "gh auth login"],
    [{ noRepository: true }, "not a clone of a GitHub repository"],
    [{ noProject: true }, "has no open Projects board"],
    [{ statusOptions: ["Todo", "In Progress", "Done"] }, "rerun init with --create-statuses"],
    [{ statusOptions: [...BOARD_STATUSES, "Parking Lot"] }, "found: Backlog, Queued, In Design, Building, Awaiting Merge, Done, Parking Lot"],
    [{ offline: true }, "gh auth login"],
  ])("refuses %j", (seeded, why) => {
    seed(seeded);
    expect(() => resolveGitHubAtInit(dir, undefined, gh())).toThrow(why);
  });

  test("--create-statuses sets the board's Status options to exactly the six, and only when asked", () => {
    seed({ statusOptions: ["Todo", "Backlog", "Done"] });
    expect(() => resolveGitHubAtInit(dir, undefined, gh())).toThrow("--create-statuses");
    expect(state().calls.some((c) => c[0] === "api")).toBe(false);
    const config = resolveGitHubAtInit(dir, undefined, gh(), { createStatuses: true });
    expect(Object.keys(config.project.options)).toEqual([...BOARD_STATUSES]);
    expect(state()["statusOptions"]).toEqual([...BOARD_STATUSES]);
  });

  test("BOUNDED_GH names a fake only under the test runner", () => {
    expect(ghExecutable({ VITEST: "true", BOUNDED_GH: "/fake" })).toBe("/fake");
    expect(ghExecutable({ BOUNDED_GH: "/fake" })).toBe("gh");
    expect(ghExecutable({ VITEST: "true" })).toBe("gh");
  });

  test("--project names the board; a malformed one is refused", () => {
    expect(parseProjectRef("3", "acme")).toEqual({ owner: "acme", number: 3 });
    expect(parseProjectRef("other/4", "acme")).toEqual({ owner: "other", number: 4 });
    expect(parseProjectRef(undefined, "acme")).toBeUndefined();
    expect(() => parseProjectRef("0", "acme")).toThrow("--project must be");
    expect(() => parseProjectRef("a/b/3", "acme")).toThrow("--project must be");
    resolveGitHubAtInit(dir, "acme/7", gh());
    expect(state().calls).toContainEqual(["project", "view", "7", "--owner", "acme", "--format", "json"]);
  });

  test("the config init writes reopens as the installation's tracker; a re-plan keeps the recorded board", () => {
    vi.stubEnv("BOUNDED_GH", FAKE_GH);
    const config = trackerConfigAtInit(dir, { project: "acme/1" });
    expect(() => openTracker(dir)).toThrow("records no tracker");
    mkdirSync(join(dir, ".bounded"));
    writeFileSync(join(dir, ".bounded", "tracker.json"), config);
    expect(() => openTracker(dir).check()).not.toThrow();
    seed({});
    trackerConfigAtInit(dir);
    expect(state().calls).toContainEqual(["project", "view", "1", "--owner", "acme", "--format", "json"]);
    expect(state().calls.some((c) => c[0] === "project" && c[1] === "list")).toBe(false);
  });

  test("malformed settings are refused", () => {
    expect(() => gitHubSettings({ repository: "nope" })).toThrow("owner/name");
    expect(() => gitHubSettings({ repository: "a/b" })).toThrow("'project' is missing");
    expect(() => gitHubSettings({ repository: "a/b", project: { owner: "a", number: 1, id: "x", title: "t", statusFieldId: "f", options: {} } }))
      .toThrow("an option for every status");
  });
});

describe("the tracker port over gh", () => {
  test("create, status, labels, comment, close — each through the documented gh call", () => {
    const tracker = gitHubTracker(settings(), gh());
    const created = tracker.createIssue("Invoices", "## Outcome\n\nx");
    expect(created).toEqual({ number: 1, url: "https://github.com/acme/shop/issues/1" });
    expect(tracker.viewIssue(1)).toEqual({ number: 1, title: "Invoices", body: "## Outcome\n\nx", state: "open", labels: [] });
    tracker.setStatus(1, "Backlog");
    tracker.setStatus(1, "Queued");
    expect(tracker.viewIssue(1).status).toBe("Queued");
    tracker.addLabel(1, "blocked: builder");
    expect(tracker.viewIssue(1).labels).toEqual(["blocked: builder"]);
    expect(tracker.issuesWithLabel("blocked: builder")).toEqual([1]);
    tracker.removeLabel(1, "blocked: builder");
    tracker.comment(1, "`design-gate`: PASS — frozen");
    tracker.close(1);
    expect(tracker.viewIssue(1)).toMatchObject({ state: "closed", labels: [] });
    const calls = state().calls;
    expect(calls).toContainEqual(["project", "item-edit", "--id", "PVTI_1", "--project-id", "PVT_1", "--field-id", "F_status", "--single-select-option-id", "opt-queued"]);
    // The label is created once, never forced over an existing one.
    tracker.addLabel(1, "blocked: builder");
    const creates = state().calls.filter((c) => c[0] === "label" && c[1] === "create");
    expect(creates).toEqual([["label", "create", "blocked: builder", "--repo", "acme/shop", "--color", "ededed"]]);
    expect(state().issues["1"]!["comments"]).toEqual(["`design-gate`: PASS — frozen"]);
  });

  test("the board is matched by the id init recorded, not by its title", () => {
    const tracker = gitHubTracker(settings(), gh());
    tracker.createIssue("A", "b");
    tracker.setStatus(1, "Building");
    expect(tracker.viewIssue(1).status).toBe("Building");
    const other = gitHubSettings({ ...(resolveGitHubAtInit(dir, undefined, gh()) as unknown as Record<string, unknown>) });
    const renamed = gitHubTracker({ ...other, project: { ...other.project, id: "PVT_other", title: "Shop" } }, gh());
    expect(renamed.viewIssue(1).status).toBeUndefined();
  });

  test("an unreachable or failing gh is a TrackerError that names the call", () => {
    const tracker = gitHubTracker(settings(), gh());
    seed({ offline: true });
    expect(() => tracker.check()).toThrow(/gh auth status failed: error connecting/);
    expect(() => tracker.viewIssue(1)).toThrow(/gh api graphql failed/);
    seed({});
    expect(() => tracker.viewIssue(9)).toThrow("issue #9 not found");
    expect(() => gitHubTracker(settings(), ghCommandLine(join(dir, "no-such-gh"))).check()).toThrow(/gh auth status failed/);
  });
});
