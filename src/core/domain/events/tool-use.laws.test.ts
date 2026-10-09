import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { ToolUse } from "./tool-use.ts";

const edit = { role: "builder", tool: "edit", effects: [{ kind: "write", path: "src/a.ts", change: "modify" }] };
const run = { role: null, tool: "shell", effects: [{ kind: "execute", command: "make build" }] };
const grep = { role: null, tool: "search", effects: [{ kind: "list", root: "src", filter: "*.ts" }, { kind: "read", path: "src" }] };
valueObjectLaws("ToolUse", ToolUse, [edit, run, grep], [{ ...edit, tool: "bash" }, { ...edit, effects: [] }, { ...edit, effects: [{ kind: "read", path: "/etc/hosts" }] }]);
