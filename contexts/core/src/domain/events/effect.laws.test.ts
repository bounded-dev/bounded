import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { Effect } from "./effect.ts";

const read = { kind: "read", path: "src/a.ts" };
const list = { kind: "list", root: "src", filter: "*.ts" };
const write = { kind: "write", path: "src/a.ts", change: "modify" };
const execute = { kind: "execute", command: "make build" };
const fetch = { kind: "fetch", url: "https://example.com/a" };
const delegate = { kind: "delegate", agent: "explore" };
const invoke = { kind: "invoke", name: "mcp__docs__search" };
valueObjectLaws("Effect", Effect, [read, list, write, execute, fetch, delegate, invoke], [{ kind: "delete", path: "a" }, { ...read, path: "/etc/hosts" }, { ...write, change: "rename" }]);
