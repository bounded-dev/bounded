// The GitHub adapter for the tracker port (src/tracker.ts, ADR 2026-066).
// Everything GitHub-specific lives here: the `gh` command line, issue and
// label vocabulary, and the Projects board whose single-select Status field
// carries the harness's board statuses. The core never names any of it.
//
// Every call goes through one `GhRun`, so tests replace the command line with
// a fake and never touch the network.

import { spawnSync } from "node:child_process";
import {
  BOARD_STATUSES, isBoardStatus, TrackerError, type BoardStatus, type Tracker, type TrackerIssue,
} from "../src/tracker.ts";

export const GITHUB_KIND = "github";

/** One `gh` invocation: argv after `gh`, run in `cwd` when given. */
export type GhRun = (args: readonly string[], cwd?: string) => { readonly status: number; readonly stdout: string; readonly stderr: string };

/** The real command line. `BOUNDED_GH` names another executable, so a test
 *  of a spawned command can point it at a fake. */
export function ghCommandLine(bin: string = process.env["BOUNDED_GH"] ?? "gh"): GhRun {
  return (args, cwd) => {
    const run = spawnSync(bin, [...args], { encoding: "utf8", ...(cwd !== undefined ? { cwd } : {}), maxBuffer: 16 * 1024 * 1024 });
    if (run.error !== undefined) return { status: 127, stdout: "", stderr: run.error.message };
    return { status: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
  };
}

export interface GitHubSettings {
  readonly repository: string;
  readonly project: {
    readonly owner: string;
    readonly number: number;
    readonly id: string;
    readonly title: string;
    readonly statusFieldId: string;
    /** Board status → the Status field's option id. */
    readonly options: Readonly<Record<BoardStatus, string>>;
  };
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Narrow the opaque settings the core read from the tracker config. */
export function gitHubSettings(raw: Readonly<Record<string, unknown>>): GitHubSettings {
  const repository = raw["repository"];
  const project = raw["project"];
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) throw new TrackerError("tracker config: 'repository' must be owner/name");
  if (project === null || typeof project !== "object" || Array.isArray(project)) throw new TrackerError("tracker config: 'project' is missing");
  const p = project as Record<string, unknown>;
  const options = p["options"];
  if (typeof p["owner"] !== "string" || typeof p["number"] !== "number" || typeof p["id"] !== "string" ||
      typeof p["title"] !== "string" || typeof p["statusFieldId"] !== "string" ||
      options === null || typeof options !== "object" ||
      !BOARD_STATUSES.every((s) => typeof (options as Record<string, unknown>)[s] === "string")) {
    throw new TrackerError("tracker config: 'project' must name the board, its Status field and an option for every status");
  }
  return { repository, project: p as unknown as GitHubSettings["project"] };
}

function call(run: GhRun, args: readonly string[], cwd?: string): string {
  const result = run(args, cwd);
  if (result.status !== 0) {
    const why = (result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`).split("\n").slice(-3).join(" ");
    throw new TrackerError(`gh ${args.slice(0, 2).join(" ")} failed: ${why}`);
  }
  return result.stdout;
}

function json<T>(run: GhRun, args: readonly string[], cwd?: string): T {
  const out = call(run, args, cwd);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new TrackerError(`gh ${args.slice(0, 2).join(" ")} printed something other than JSON`);
  }
}

const ISSUE_URL = /\/issues\/([1-9][0-9]*)\s*$/;

export function gitHubTracker(settings: GitHubSettings, run: GhRun = ghCommandLine()): Tracker {
  const repo = ["--repo", settings.repository];
  const { project } = settings;
  const issueUrl = (issue: number): string => `https://github.com/${settings.repository}/issues/${issue}`;
  return {
    check() {
      call(run, ["auth", "status"]);
      json(run, ["repo", "view", settings.repository, "--json", "nameWithOwner"]);
    },
    createIssue(title, body) {
      const url = call(run, ["issue", "create", ...repo, "--title", title, "--body", body]).trim();
      const match = ISSUE_URL.exec(url);
      if (match === null) throw new TrackerError(`gh issue create printed no issue URL ('${url.slice(0, 200)}')`);
      return { number: Number(match[1]), url };
    },
    viewIssue(issue): TrackerIssue {
      const raw = json<{
        number: number; title: string; body: string; state: string;
        labels: { name: string }[]; projectItems?: { title: string; status?: { name?: string } | null }[];
      }>(run, ["issue", "view", String(issue), ...repo, "--json", "number,title,body,state,labels,projectItems"]);
      const item = (raw.projectItems ?? []).find((i) => i.title === project.title);
      const status = item?.status?.name;
      return {
        number: raw.number, title: raw.title, body: raw.body ?? "",
        state: raw.state.toUpperCase() === "OPEN" ? "open" : "closed",
        labels: raw.labels.map((l) => l.name),
        ...(isBoardStatus(status) ? { status } : {}),
      };
    },
    setStatus(issue, status) {
      // item-add answers with the existing item when the issue is already on the board.
      const item = json<{ id: string }>(run, [
        "project", "item-add", String(project.number), "--owner", project.owner, "--url", issueUrl(issue), "--format", "json",
      ]);
      call(run, [
        "project", "item-edit", "--id", item.id, "--project-id", project.id,
        "--field-id", project.statusFieldId, "--single-select-option-id", project.options[status],
      ]);
    },
    addLabel(issue, label) {
      call(run, ["label", "create", label, ...repo, "--force", "--color", "ededed"]);
      call(run, ["issue", "edit", String(issue), ...repo, "--add-label", label]);
    },
    removeLabel(issue, label) {
      call(run, ["issue", "edit", String(issue), ...repo, "--remove-label", label]);
    },
    issuesWithLabel(label) {
      return json<{ number: number }[]>(run, ["issue", "list", ...repo, "--label", label, "--state", "open", "--json", "number"])
        .map((i) => i.number);
    },
    comment(issue, body) {
      call(run, ["issue", "comment", String(issue), ...repo, "--body", body]);
    },
    close(issue) {
      call(run, ["issue", "close", String(issue), ...repo]);
    },
  };
}

// ── Initialization ──────────────────────────────────────────────────────────

/** `--project` as given to init: `<number>` (the repository owner's) or `<owner>/<number>`. */
export function parseProjectRef(ref: string | undefined, repoOwner: string): { owner: string; number: number } | undefined {
  if (ref === undefined) return undefined;
  const match = /^(?:([A-Za-z0-9_.-]+)\/)?([1-9][0-9]*)$/.exec(ref);
  if (match === null) throw new TrackerError(`--project must be <number> or <owner>/<number>, not '${ref}'`);
  return { owner: match[1] ?? repoOwner, number: Number(match[2]) };
}

/**
 * What init records for GitHub, or a refusal saying exactly what is missing:
 * an authenticated `gh`, a GitHub repository at `target`, and a Projects board
 * whose Status field has exactly the harness's statuses.
 */
export function resolveGitHubAtInit(
  target: string,
  projectRef: string | undefined,
  run: GhRun = ghCommandLine(),
): { readonly kind: string } & GitHubSettings {
  if (run(["auth", "status"]).status !== 0) {
    throw new TrackerError("GitHub is required: `gh` is not installed or not authenticated — run `gh auth login`");
  }
  const repoRun = run(["repo", "view", "--json", "nameWithOwner,owner"], target);
  if (repoRun.status !== 0) {
    throw new TrackerError("GitHub is required: this directory is not a clone of a GitHub repository — create the repository, clone it and run init inside the clone");
  }
  let repo: { nameWithOwner: string; owner: { login: string } };
  try { repo = JSON.parse(repoRun.stdout) as typeof repo; } catch { throw new TrackerError("gh repo view printed something other than JSON"); }
  let ref = parseProjectRef(projectRef, repo.owner.login);
  if (ref === undefined) {
    const listed = json<{ projects: { number: number; closed: boolean }[] }>(run, ["project", "list", "--owner", repo.owner.login, "--format", "json"]);
    const open = listed.projects.filter((p) => !p.closed);
    if (open.length !== 1) {
      throw new TrackerError(open.length === 0
        ? `GitHub is required: ${repo.owner.login} has no open Projects board — create one (gh project create --owner ${repo.owner.login} --title <name>) and rerun with --project <number>`
        : `${repo.owner.login} has ${open.length} open Projects boards — rerun with --project <number> to choose one`);
    }
    ref = { owner: repo.owner.login, number: open[0]!.number };
  }
  const view = json<{ id: string; title: string }>(run, ["project", "view", String(ref.number), "--owner", ref.owner, "--format", "json"]);
  const fields = json<{ fields: { id: string; name: string; options?: { id: string; name: string }[] }[] }>(
    run, ["project", "field-list", String(ref.number), "--owner", ref.owner, "--format", "json"]);
  const status = fields.fields.find((f) => f.name === "Status" && Array.isArray(f.options));
  const names = (status?.options ?? []).map((o) => o.name);
  const exact = status !== undefined && names.length === BOARD_STATUSES.length && BOARD_STATUSES.every((s) => names.includes(s));
  if (!exact) {
    throw new TrackerError(
      `the board's Status field must have exactly these options: ${BOARD_STATUSES.join(", ")} ` +
      `(found: ${names.length > 0 ? names.join(", ") : "no Status field"}) — edit the field on ${ref.owner}'s project ${ref.number} and rerun`);
  }
  const options = Object.fromEntries(BOARD_STATUSES.map((s) => [s, status.options!.find((o) => o.name === s)!.id])) as Record<BoardStatus, string>;
  return {
    kind: GITHUB_KIND,
    repository: repo.nameWithOwner,
    project: { owner: ref.owner, number: ref.number, id: view.id, title: view.title, statusFieldId: status.id, options },
  };
}
