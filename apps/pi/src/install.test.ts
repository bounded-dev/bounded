import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { piLoader } from "./install.ts";
import { piRuntimeAvailable, underPi } from "./pi-runtime.test-support.ts";

describe("piLoader — the file pi loads as the project's bounded extension", () => {
  test("lives where pi discovers project extensions", () => {
    expect(piLoader().path).toBe(".pi/extensions/bounded/index.ts");
  });

  test("is the same every time: it names no machine, user or absolute path", () => {
    expect(piLoader()).toEqual(piLoader());
    expect(piLoader().content).not.toMatch(/\/(Users|home|tmp|var)\//);
    expect(piLoader().content).toContain('"bounded-pi"');
  });
});

/** A project holding the loader, and optionally a stand-in bounded-pi with the given module source. */
function project(boundedPi?: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-pi-install-")));
  if (boundedPi !== undefined) {
    const stub = join(root, "node_modules", "bounded-pi");
    mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, "package.json"), JSON.stringify({ name: "bounded-pi", type: "module", exports: { ".": "./index.js" } }));
    writeFileSync(join(stub, "index.js"), boundedPi);
  }
  const loader = piLoader();
  mkdirSync(dirname(join(root, loader.path)), { recursive: true });
  writeFileSync(join(root, loader.path), loader.content);
  return root;
}

/** Loads the project's loader as pi does, runs its factory on a fake pi, and sends it one tool call. */
function load(root: string): { events: string[]; root?: string; result: unknown } {
  const body = `const [root, loader] = process.argv.slice(2);
const factory = await load(loader, { default: true });
const handlers = {};
const pi = { on(event, handler) { (handlers[event] ??= []).push(handler); } };
await factory(pi);
const result = handlers.tool_call ? await handlers.tool_call.at(-1)({ type: "tool_call", toolName: "read", input: { path: "a.ts" } }, { cwd: root }) : null;
console.log(JSON.stringify({ events: Object.keys(handlers).sort(), root: pi.root, result: result ?? null }));`;
  return underPi(body, root, join(root, piLoader().path)) as { events: string[]; root?: string; result: unknown };
}

describe("piLoader — loaded by pi's own jiti, under node", () => {
  test.skipIf(!piRuntimeAvailable)("hands the project root to bounded-pi's extension", () => {
    const root = project('export const bounded = (root) => (pi) => { pi.root = root; pi.on("session_start", () => {}); };\n');
    expect(load(root)).toEqual({ events: ["session_start"], root, result: null });
  });

  test.skipIf(!piRuntimeAvailable)("when bounded-pi cannot be loaded, blocks every tool call, saying how to fix it", () => {
    const loaded = load(project());
    expect(loaded.events).toEqual(["tool_call"]);
    expect(loaded.result).toMatchObject({ block: true });
    const reason = (loaded.result as { reason: string }).reason;
    expect(reason).toContain("bounded could not load");
    expect(reason).toContain("bounded-pi");
    expect(reason.split("\n")).toHaveLength(2);
  });

  test.skipIf(!piRuntimeAvailable)("when bounded-pi's extension throws while registering, blocks every tool call", () => {
    const loaded = load(project('export const bounded = () => () => { throw new Error("broken install"); };\n'));
    expect(loaded.events).toEqual(["tool_call"]);
    expect((loaded.result as { reason: string }).reason).toContain("broken install");
  });
});
