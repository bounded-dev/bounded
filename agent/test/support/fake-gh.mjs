#!/usr/bin/env node
// A stand-in for the `gh` command line, for tests that spawn a harness command
// (ADR 2026-066). Point BOUNDED_GH at this file and FAKE_GH_STATE at a JSON
// file; the fake answers from that file, applies every change to it, and
// appends each call's argv to its `calls`. Set `offline: true` in the state to
// make every call fail as an unreachable network would.
//
// It answers only what trackers/github.ts asks; anything else exits 2.

import { readFileSync, writeFileSync } from "node:fs";

const path = process.env.FAKE_GH_STATE;
if (!path) { process.stderr.write("fake gh: FAKE_GH_STATE is not set\n"); process.exit(2); }
const state = JSON.parse(readFileSync(path, "utf8"));
const args = process.argv.slice(2);
state.calls = [...(state.calls ?? []), args];
const save = () => writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
const out = (value) => { save(); process.stdout.write(typeof value === "string" ? value : JSON.stringify(value)); process.exit(0); };
const fail = (why, code = 1) => { save(); process.stderr.write(`${why}\n`); process.exit(code); };
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const flags = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

if (state.offline) fail("error connecting to api.github.com");
state.issues ??= {};
state.labels ??= [];
const repository = state.repository ?? "acme/shop";
const owner = repository.split("/")[0];
const project = state.project ?? { number: 1, id: "PVT_1", title: "Shop" };
const options = state.statusOptions ?? ["Backlog", "Queued", "In Design", "Building", "Awaiting Merge", "Done"];
const optionId = (name) => `opt-${name.toLowerCase().replace(/ /g, "-")}`;
const issueOf = (n) => state.issues[String(n)] ?? fail(`issue ${n} not found`);

const [a, b] = args;
if (a === "auth" && b === "status") { if (state.unauthenticated) fail("not logged in"); out(""); }
if (a === "repo" && b === "view") {
  if (state.noRepository) fail("no git remotes found");
  out({ nameWithOwner: repository, owner: { login: owner } });
}
if (a === "project" && b === "list") out({ projects: state.noProject ? [] : [{ number: project.number, closed: false }], totalCount: 1 });
if (a === "project" && b === "view") out({ id: project.id, title: project.title });
if (a === "project" && b === "field-list") {
  out({ fields: [{ id: "F_title", name: "Title" }, { id: "F_status", name: "Status", options: options.map((name) => ({ id: optionId(name), name })) }] });
}
if (a === "project" && b === "item-add") {
  const n = Number(/\/issues\/(\d+)$/.exec(flag("--url") ?? "")?.[1]);
  const issue = issueOf(n);
  issue.item ??= `PVTI_${n}`;
  out({ id: issue.item });
}
if (a === "project" && b === "item-edit") {
  const issue = Object.values(state.issues).find((i) => i.item === flag("--id")) ?? fail("no such item");
  const option = flag("--single-select-option-id");
  issue.status = options.find((name) => optionId(name) === option) ?? fail("no such option");
  out("");
}
if (a === "issue" && b === "create") {
  const n = (state.nextIssue ?? 1);
  state.nextIssue = n + 1;
  state.issues[String(n)] = { number: n, title: flag("--title"), body: flag("--body") ?? "", state: "OPEN", labels: [] };
  out(`https://github.com/${repository}/issues/${n}\n`);
}
if (a === "issue" && b === "view") {
  const issue = issueOf(args[2]);
  out({
    number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    projectItems: issue.item ? [{ title: project.title, status: { optionId: "", name: issue.status ?? "" } }] : [],
  });
}
if (a === "issue" && b === "edit") {
  const issue = issueOf(args[2]);
  for (const label of flags("--add-label")) {
    if (!state.labels.includes(label)) fail(`'${label}' not found`);
    if (!issue.labels.includes(label)) issue.labels.push(label);
  }
  for (const label of flags("--remove-label")) issue.labels = issue.labels.filter((l) => l !== label);
  out("");
}
if (a === "issue" && b === "list") {
  const label = flag("--label");
  out(Object.values(state.issues).filter((i) => i.state === "OPEN" && i.labels.includes(label)).map((i) => ({ number: i.number })));
}
if (a === "issue" && b === "comment") { const issue = issueOf(args[2]); (issue.comments ??= []).push(flag("--body")); out(""); }
if (a === "issue" && b === "close") { issueOf(args[2]).state = "CLOSED"; out(""); }
if (a === "label" && b === "create") { if (!state.labels.includes(args[2])) state.labels.push(args[2]); out(""); }
fail(`fake gh: unsupported call: ${args.join(" ")}`, 2);
