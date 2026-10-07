import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolResult, ToolUse, Verdict } from "bounded/domain";
import type { openProject } from "bounded/open-project";
import { composeProject } from "./composition-root.ts";
import { type Pi, type PiHandler, piExtension } from "./extension.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-pi-root-")));
const parsed = ToolUse.parse({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: "a.ts" }] });
if (!parsed.ok) throw new Error(parsed.error);
const event = parsed.value;
type Open = typeof openProject;

const rejecting: Open = async () => {
  throw new Error("the log directory cannot be created");
};
const judging = (judge: (event: unknown) => Promise<never>): Open => async () => ({ judge, afterTool: async () => ({ changed: [], restored: true, message: null }), refuse: async () => Verdict.refuse("refused", "fix it"), problem: null });

describe("composeProject — never fails open, whatever openProject or its judge does", () => {
  test("an openProject that rejects gives a decide that refuses every event, saying why", async () => {
    const decide = await composeProject(root, rejecting);
    const verdict = await decide(event);
    expect(verdict.kind).toBe("refuse");
    expect(verdict.kind === "refuse" && verdict.reason).toContain("the log directory cannot be created");
    expect(verdict.kind === "refuse" && verdict.redirect.trim()).not.toBe("");
  });

  test("a judge that rejects or throws refuses that event", async () => {
    const rejected = await (await composeProject(root, judging(async () => { throw new Error("log write failed"); })))(event);
    expect(rejected.kind === "refuse" && rejected.reason).toContain("log write failed");
    const thrown = await (await composeProject(root, judging(() => { throw new Error("judge broke"); })))(event);
    expect(thrown.kind === "refuse" && thrown.reason).toContain("judge broke");
  });

  test("the decide carries the project's afterTool and refuse; an openProject that rejects has neither", async () => {
    const decide = await composeProject(root);
    const result = ToolResult.parse({ kind: "tool-result", role: null, tool: "shell", effects: [{ kind: "execute", command: "ls" }], ok: true, callId: "1" });
    if (!result.ok) throw new Error(result.error);
    expect(await decide.afterTool?.(result.value)).toMatchObject({ message: null });
    await decide.refuse?.({ tool: "read", reason: "outside the project", redirect: "use a path inside it", role: null, input: {} });
    const log = join(root, ".bounded", "guard-log.jsonl");
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, "utf8")).toContain('"event":"adapter"');
    const failed = await composeProject(root, rejecting);
    expect(failed.afterTool).toBeUndefined();
    expect(failed.refuse).toBeUndefined();
  });

  test("the refusal reaches pi as a block with a reason and a redirect", async () => {
    let handler: PiHandler | undefined;
    let start: PiHandler | undefined;
    const pi: Pi = {
      on(name, h) {
        if (name === "tool_call") handler = h;
        else if (name === "session_start") start = h;
      },
    };
    piExtension({ root, load: () => composeProject(root, rejecting) })(pi);
    await start?.({ type: "session_start" }, { cwd: root });
    const result = await handler?.({ type: "tool_call", toolName: "read", input: { path: "a.ts" } }, { cwd: root });
    expect(result).toMatchObject({ block: true });
    const lines = (result as { reason: string }).reason.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("the log directory cannot be created");
  });
});
