// bounded-pi with the real core: a temporary project with its own
// bounded.config.ts, driven through a fake pi, judged by openProject and
// recorded in the project's Bounded log.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Pi, PiHandler } from "./extension.ts";
import { bounded } from "./index.ts";
import { piRuntimeAvailable, reportPiRuntime, underPi } from "./pi-runtime.test-support.ts";

// The project resolves `bounded` as an installed project would: from its node_modules.
const CORE = resolve(import.meta.dir, "../..");
const CONFIG = `import { contribution, corePack, defineConfig, Verdict } from "bounded/domain";
export default defineConfig({
  packs: [corePack],
  contributes: [contribution(corePack.points.effectGuards.write, [(effect) => (effect.path.value.startsWith("generated/") ? Verdict.refuse("generated/ is written by the generator", "Change the generator's input instead") : Verdict.allow)])],
});
`;

function project(config: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-pi-e2e-")));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(CORE, join(root, "node_modules", "bounded"), "dir");
  mkdirSync(join(root, "generated"));
  writeFileSync(join(root, "bounded.config.ts"), config);
  return root;
}

async function session(root: string) {
  const handlers = new Map<string, PiHandler>();
  const pi: Pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  bounded(root)(pi);
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, { cwd: root });
  return (toolName: string, input: unknown) => handlers.get("tool_call")?.({ type: "tool_call", toolCallId: "1", toolName, input }, { cwd: root });
}

const logged = (root: string): { event: string; verdict: { kind: string } }[] =>
  readFileSync(join(root, ".bounded", "log.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));

describe("bounded-pi end to end — a project's bounded.config.ts judging pi's calls", () => {
  test("blocks a write its guard refuses, allows a read, and records both decisions", async () => {
    const root = project(CONFIG);
    const call = await session(root);
    expect(await call("write", { path: "generated/api.ts", content: "x" })).toEqual({
      block: true,
      reason: "bounded/project refused write (create) generated/api.ts: generated/ is written by the generator\nChange the generator's input instead",
    });
    expect(await call("read", { path: "src/a.ts" })).toBeUndefined();
    expect(logged(root).map((line) => line.verdict.kind)).toEqual(["refuse", "allow"]);
  });

  test("a configuration that cannot be used blocks every call, saying why and what to do", async () => {
    const root = project("export default 42;\n");
    const call = await session(root);
    const result = await call("read", { path: "a.ts" });
    expect(result).toMatchObject({ block: true });
    const [reason, redirect] = (result as { reason: string }).reason.split("\n");
    expect(reason).toContain("This project's configuration cannot be used");
    expect(redirect).not.toBe("");
    expect(logged(root).map((line) => line.verdict.kind)).toEqual(["refuse"]);
  });
});

/** The same session, run as pi runs it: bounded-pi loaded through pi's jiti, under node. */
function sessionUnderPi(root: string, calls: readonly (readonly [string, unknown])[]): { results: unknown[]; log: string[] } {
  const body = `const [index, root, calls] = process.argv.slice(2);
const { bounded } = await load(index);
const handlers = {};
bounded(root)({ on(event, handler) { handlers[event] = handler; } });
await handlers.session_start({ type: "session_start", reason: "startup" }, { cwd: root });
const results = [];
for (const [toolName, input] of JSON.parse(calls)) results.push((await handlers.tool_call({ type: "tool_call", toolCallId: "1", toolName, input }, { cwd: root })) ?? null);
const { readFileSync } = await import("node:fs");
const log = readFileSync(root + "/.bounded/log.jsonl", "utf8").split("\\n").filter((line) => line !== "").map((line) => JSON.parse(line).verdict.kind);
console.log(JSON.stringify({ results, log }));`;
  return underPi(body, join(import.meta.dir, "index.ts"), root, JSON.stringify(calls)) as { results: unknown[]; log: string[] };
}

describe("bounded-pi end to end — under pi's runtime (node, through pi's jiti)", () => {
  reportPiRuntime();

  test.skipIf(!piRuntimeAvailable)("blocks a write its guard refuses, allows another write, and records both decisions", () => {
    const root = project(CONFIG);
    const { results, log } = sessionUnderPi(root, [
      ["write", { path: "generated/api.ts", content: "x" }],
      ["write", { path: "src/a.ts", content: "x" }],
    ]);
    expect(results).toEqual([
      { block: true, reason: "bounded/project refused write (create) generated/api.ts: generated/ is written by the generator\nChange the generator's input instead" },
      null,
    ]);
    expect(log).toEqual(["refuse", "allow"]);
  });

  test.skipIf(!piRuntimeAvailable)("a configuration that cannot be used blocks every call", () => {
    const root = project("export default 42;\n");
    const { results, log } = sessionUnderPi(root, [["read", { path: "a.ts" }]]);
    expect(results).toMatchObject([{ block: true }]);
    expect((results[0] as { reason: string }).reason).toContain("This project's configuration cannot be used");
    expect(log).toEqual(["refuse"]);
  });
});
