import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { Effect } from "./effect.ts";

const read = { kind: "read", path: "src/a.ts" };
const list = { kind: "list", root: "src", filter: "*.ts" };
const write = { kind: "write", path: "src/a.ts", change: "modify" };
const execute = { kind: "execute", command: "make build" };
const fetch = { kind: "fetch", url: "https://example.com/a" };
const delegate = { kind: "delegate", agent: "explore" };
const invoke = { kind: "invoke", name: "mcp__docs__search" };
const delegateFlagged = { kind: "delegate", agent: "explore", isolated: true, finishUnreported: true };
const READ_SAMPLE = {
  outcome: "read",
  programs: [{ name: { kind: "literal", text: "cat" }, arguments: [{ kind: "literal", text: ".env" }, { kind: "unresolved", text: "$X" }], workingDirectory: "." }],
  fileEffects: [
    { effect: { kind: "read", path: ".env" } },
    { effect: { kind: "write", path: "out.txt", change: "create" }, existenceUnknown: true },
    { effect: { kind: "write", path: "out.txt", change: "modify" }, existenceUnknown: true },
  ],
  unresolved: [{ text: "$X", role: "read" }],
};
const executeRead = { kind: "execute", command: "cat .env $X", reading: READ_SAMPLE };
valueObjectLaws(
  "Effect",
  Effect,
  [read, list, write, execute, fetch, delegate, invoke, delegateFlagged, executeRead],
  [{ kind: "delete", path: "a" }, { ...read, path: "/etc/hosts" }, { ...write, change: "rename" }, { ...delegate, isolated: "no" }, { ...execute, reading: { outcome: "maybe" } }],
);
