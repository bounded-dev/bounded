// The GitHub adapter for the tracker port (src/tracker.ts, ADR LEG-2026-066).
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

/** The executable to run: `gh`, or — only under the test runner — the fake
 *  that `BOUNDED_GH` names, so no installed harness can be pointed elsewhere. */
export function ghExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env["VITEST"] === "true" && env["BOUNDED_GH"] !== undefined && env["BOUNDED_GH"] !== "" ? env["BOUNDED_GH"] : "gh";
}

/** The real command line. */
export function ghCommandLine(bin: string = ghExecutable()): GhRun {
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

/** Signing in is the user's: it needs their own credentials. */
const SIGN_IN = "GitHub sign-in is needed: signing in is the user's own step, `gh auth login`, because it needs their own GitHub " +
  "credentials, which the harness never holds";
/** Granting the board scope is the user's: it changes what their credentials allow. */
const PROJECT_SCOPE = "the GitHub sign-in needs project access: granting it is the user's own step, `gh auth refresh -s project`, " +
  "because it changes what their own GitHub credentials allow, which the harness never holds";

/**
 * A failed `gh` call as a TrackerError in product terms (ADR LEG-2026-072): the
 * known failures by what they mean for the user, never `gh`'s own text,
 * which can name commands; that raw text is kept in `raw` for the guard log.
 */
export function ghFailure(args: readonly string[], output: string): TrackerError {
  const raw = `gh ${args.slice(0, 2).join(" ")}: ${output.trim().split("\n").slice(-3).join(" ")}`;
  const what = args[0] === "project" ? "the project board" : args[0] === "issue" ? "an issue" : args[0] === "label" ? "a label" : "GitHub";
  const meaning =
    /required scopes|INSUFFICIENT_SCOPES|auth refresh|read:project|\bscopes?\b/i.test(output) ? PROJECT_SCOPE
    : /HTTP 401|Bad credentials|not logged in|auth login|authentication required|token .*(expired|invalid)/i.test(output) ? SIGN_IN
    : /Could not resolve to a|HTTP 404|not found/i.test(output) ? `GitHub could not find ${what === "GitHub" ? "the repository or the project board" : what} the harness was set up with`
    : /error connecting|could not connect|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|network|timed out|no such host/i.test(output) ? "GitHub could not be reached; check the network connection"
    : `GitHub refused a request about ${what}`;
  return new TrackerError(meaning, raw);
}

function call(run: GhRun, args: readonly string[], cwd?: string): string {
  const result = run(args, cwd);
  if (result.status !== 0) throw ghFailure(args, result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
  return result.stdout;
}

function json<T>(run: GhRun, args: readonly string[], cwd?: string): T {
  const out = call(run, args, cwd);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new TrackerError("GitHub answered a request with something the harness could not read", `gh ${args.slice(0, 2).join(" ")} printed: ${out.slice(0, 400)}`);
  }
}

const ISSUE_URL = /\/issues\/([1-9][0-9]*)\s*$/;

/** An issue with its board items, read by GraphQL so the board is matched by
 *  its id (which init records), never by its title. */
const ISSUE_QUERY = [
  "query($owner: String!, $name: String!, $number: Int!) {",
  "  repository(owner: $owner, name: $name) { issue(number: $number) {",
  "    number title body state labels(first: 100) { nodes { name } }",
  "    projectItems(first: 50) { nodes { project { id } fieldValueByName(name: \"Status\") {",
  "      ... on ProjectV2ItemFieldSingleSelectValue { optionId } } } }",
  "  } }",
  "}",
].join("\n");

interface IssueNode {
  number: number; title: string; body: string; state: string;
  labels: { nodes: { name: string }[] };
  projectItems: { nodes: { project: { id: string }; fieldValueByName: { optionId?: string } | null }[] };
}

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
      if (match === null) throw new TrackerError("GitHub created the issue but did not say where", `gh issue create printed: ${url.slice(0, 200)}`);
      return { number: Number(match[1]), url };
    },
    viewIssue(issue): TrackerIssue {
      const [owner, name] = settings.repository.split("/") as [string, string];
      const data = json<{ data?: { repository?: { issue?: IssueNode | null } | null } }>(run, [
        "api", "graphql", "-f", `query=${ISSUE_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${issue}`,
      ]);
      const raw = data.data?.repository?.issue;
      if (raw === undefined || raw === null) throw new TrackerError(`issue #${issue} not found in ${settings.repository}`);
      const item = raw.projectItems.nodes.find((i) => i.project.id === project.id);
      const optionId = item?.fieldValueByName?.optionId;
      const status = BOARD_STATUSES.find((s) => project.options[s] === optionId);
      return {
        number: raw.number, title: raw.title, body: raw.body ?? "",
        state: raw.state.toUpperCase() === "OPEN" ? "open" : "closed",
        labels: raw.labels.nodes.map((l) => l.name),
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
      // Created only when missing: an existing label keeps its colour and description.
      const existing = json<{ name: string }[]>(run, ["label", "list", ...repo, "--search", label, "--limit", "100", "--json", "name"]);
      if (!existing.some((l) => l.name === label)) call(run, ["label", "create", label, ...repo, "--color", "ededed"]);
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
/** Set the board's Status options to exactly the harness's statuses. */
const SET_STATUSES = [
  "mutation($field: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {",
  "  updateProjectV2Field(input: { fieldId: $field, singleSelectOptions: $options }) { clientMutationId }",
  "}",
].join("\n");

/**
 * GitHub access is missing: the GitHub command-line tool is not installed or
 * not signed in. Signing in is the one GitHub step reserved for the user
 * (USER_RECOVERY_COMMANDS, ADR LEG-2026-072): it needs the user's own
 * credentials, which the harness never holds.
 */
export function gitHubSignInError(): TrackerError {
  return new TrackerError(`GitHub is required, and GitHub access is missing: the GitHub command-line tool is not installed or not signed in. ${SIGN_IN}`);
}

export function resolveGitHubAtInit(
  target: string,
  projectRef: string | undefined,
  run: GhRun = ghCommandLine(),
  init: { readonly createStatuses?: boolean } = {},
): { readonly kind: string } & GitHubSettings {
  if (run(["auth", "status"]).status !== 0) {
    throw gitHubSignInError();
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
  const statusField = () => json<{ fields: { id: string; name: string; options?: { id: string; name: string }[] }[] }>(
    run, ["project", "field-list", String(ref.number), "--owner", ref.owner, "--format", "json"])
    .fields.find((f) => f.name === "Status" && Array.isArray(f.options));
  const exactly = (field: ReturnType<typeof statusField>): boolean => {
    const names = (field?.options ?? []).map((o) => o.name);
    return field !== undefined && names.length === BOARD_STATUSES.length && BOARD_STATUSES.every((s) => names.includes(s));
  };
  let status = statusField();
  if (!exactly(status) && status !== undefined && init.createStatuses === true) {
    // gh builds the list of option objects from repeated `options[][key]=value` fields.
    call(run, [
      "api", "graphql", "-f", `query=${SET_STATUSES}`, "-f", `field=${status.id}`,
      ...BOARD_STATUSES.flatMap((s) => ["-f", `options[][name]=${s}`, "-f", "options[][color]=GRAY", "-f", "options[][description]="]),
    ]);
    status = statusField();
  }
  if (!exactly(status)) {
    const names = (status?.options ?? []).map((o) => o.name);
    throw new TrackerError(
      `the board's Status field must have exactly these options: ${BOARD_STATUSES.join(", ")} ` +
      `(found: ${names.length > 0 ? names.join(", ") : "no Status field"}) — rerun init with --create-statuses to set them ` +
      `(any other option is removed, and items using it lose their status), or edit the field on ${ref.owner}'s project ${ref.number}`);
  }
  if (status === undefined) throw new TrackerError("the board has no Status field");
  const options = Object.fromEntries(BOARD_STATUSES.map((s) => [s, status.options!.find((o) => o.name === s)!.id])) as Record<BoardStatus, string>;
  return {
    kind: GITHUB_KIND,
    repository: repo.nameWithOwner,
    project: { owner: ref.owner, number: ref.number, id: view.id, title: view.title, statusFieldId: status.id, options },
  };
}
