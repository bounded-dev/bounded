// ADR 2026-064's probe and decision, against fake Docker-API servers on
// temporary unix sockets: deterministic, and no container runtime needed.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, test } from "vitest";
import type { PreparedTestService } from "../ts/pack.ts";
import { commandsIn } from "../../test/fixtures/user-steps.ts";
import {
  candidateEndpoints, drizzleStoreTests, probeContainerRuntime, storeTestDecision, storeTestEnv, storeTestPhaseDecision,
  type ContainerRuntimeProbe,
} from "./scripts/container-runtime.ts";

const temporary: string[] = [];
const servers: ChildProcess[] = [];
afterAll(() => {
  for (const server of servers) server.kill();
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

// Unix socket paths are short-limited (104 bytes on macOS), so keep them in /tmp.
function home(): string {
  const dir = mkdtempSync(join("/tmp", "cr-"));
  temporary.push(dir);
  return dir;
}

/** A fake Docker API in its own process (the probe blocks this one while it
 *  waits): answers `/_ping` with `status`, or never answers when null, and
 *  `/version` with `version.status` (200 by default; never when null), each
 *  after its delay. */
async function dockerApi(
  socket: string, status: number | null,
  version: { readonly status?: number | null; readonly pingDelayMs?: number; readonly delayMs?: number } = {},
): Promise<void> {
  mkdirSync(dirname(socket), { recursive: true });
  const answers = { "/_ping": [status, version.pingDelayMs ?? 0], "/version": [version.status === undefined ? 200 : version.status, version.delayMs ?? 0] };
  const script = `const answers = ${JSON.stringify(answers)};
require("node:http").createServer((q, r) => {
  const [code, delay] = answers[q.url] ?? [404, 0];
  if (code === null) return;
  setTimeout(() => { r.statusCode = code; r.end(q.url === "/version" ? "{}" : "OK"); }, delay);
}).listen(${JSON.stringify(socket)});`;
  servers.push(spawn(process.execPath, ["-e", script], { stdio: "ignore" }));
  for (let i = 0; i < 200 && !existsSync(socket); i++) await sleep(25);
  if (!existsSync(socket)) throw new Error(`fake Docker API did not start on ${socket}`);
}

const bare = { PATH: process.env.PATH };

describe("candidateEndpoints", () => {
  test("an explicit DOCKER_HOST is the only candidate", () => {
    expect(candidateEndpoints({ DOCKER_HOST: "tcp://10.0.0.1:2375" }, home())).toEqual(["tcp://10.0.0.1:2375"]);
  });

  test("then the Testcontainers properties file", () => {
    const dir = home();
    writeFileSync(join(dir, ".testcontainers.properties"), "ryuk.disabled=false\ndocker.host = unix:///x/docker.sock\n");
    expect(candidateEndpoints({}, dir)).toEqual(["unix:///x/docker.sock"]);
  });

  test("otherwise every known socket that exists, in a fixed order", async () => {
    const dir = home();
    await dockerApi(join(dir, ".colima/default/docker.sock"), 200);
    await dockerApi(join(dir, ".docker/run/docker.sock"), 200);
    const found = candidateEndpoints({}, dir).filter((e) => e.includes(dir));
    expect(found).toEqual([`unix://${dir}/.docker/run/docker.sock`, `unix://${dir}/.colima/default/docker.sock`]);
  });
});

describe("probeContainerRuntime", () => {
  test("available when an endpoint answers the Docker API's ping", async () => {
    const dir = home();
    await dockerApi(join(dir, "d.sock"), 200);
    expect(probeContainerRuntime({ env: { ...bare, DOCKER_HOST: `unix://${dir}/d.sock` }, home: dir }))
      .toEqual({ available: true, endpoint: `unix://${dir}/d.sock` });
  });

  test("unavailable, with the reason, when the endpoint refuses, errors or is missing", async () => {
    const dir = home();
    await dockerApi(join(dir, "sick.sock"), 500);
    const sick = probeContainerRuntime({ env: { ...bare, DOCKER_HOST: `unix://${dir}/sick.sock` }, home: dir });
    expect(sick).toEqual({ available: false, reason: `no container runtime is answering (unix://${dir}/sick.sock: answered 500)` });
    const gone = probeContainerRuntime({ env: { ...bare, DOCKER_HOST: `unix://${dir}/gone.sock` }, home: dir });
    expect(gone.available).toBe(false);
    expect((gone as { reason: string }).reason).toMatch(/gone\.sock: ENOENT/);
  });

  test("an endpoint scheme it cannot ping fails closed", () => {
    expect(probeContainerRuntime({ env: { ...bare, DOCKER_HOST: "ssh://me@host" }, home: home() }))
      .toEqual({ available: false, reason: "no container runtime is answering (ssh://me@host: unsupported endpoint scheme)" });
  });

  test("a silent endpoint is cut off at the timeout", async () => {
    const dir = home();
    await dockerApi(join(dir, "slow.sock"), null);
    const started = Date.now();
    const probe = probeContainerRuntime({ env: { ...bare, DOCKER_HOST: `unix://${dir}/slow.sock` }, home: dir, timeoutMs: 300 });
    expect((probe as { reason: string }).reason).toMatch(/did not answer within 300ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

// Issue #52: an engine that answers a ping but stalls everywhere else (a front
// proxy or VM in front of a hung daemon) is refused within seconds, not after
// half an hour of silent preparation.
describe("an engine that answers a ping but nothing else (issue #52)", () => {
  test("an engine that answers a ping but hangs on its version is not responding, within seconds", async () => {
    const dir = home();
    await dockerApi(join(dir, "hung.sock"), 200, { status: null });
    const started = Date.now();
    const probe = probeContainerRuntime({ env: { ...bare, DOCKER_HOST: `unix://${dir}/hung.sock` }, home: dir, timeoutMs: 300 });
    expect(probe.available).toBe(false);
    expect((probe as { reason: string }).reason).toMatch(/the container engine is not responding/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("the child's timeout covers both requests", async () => {
    const dir = home();
    await dockerApi(join(dir, "slow.sock"), 200, { pingDelayMs: 250, delayMs: 250 });
    expect(probeContainerRuntime({ env: { ...bare, DOCKER_HOST: `unix://${dir}/slow.sock` }, home: dir, timeoutMs: 300 }))
      .toEqual({ available: true, endpoint: `unix://${dir}/slow.sock` });
  });

  test("a refusal for an unavailable or unresponsive engine is routed to the user in product terms", () => {
    const decision = storeTestPhaseDecision({
      phase: "green",
      storeTests: ["contexts/c/src/adapters/out/drizzle/x.store.test.ts"],
      probe: () => ({ available: false, reason: "the container engine is not responding: it answered a ping but not a request for its version within 3 s" }),
    });
    expect(decision.action).toBe("refuse");
    expect(decision).toHaveProperty("route", "user");
    const reason = (decision as { reason: string }).reason;
    expect(reason).toMatch(/restart|start it/i);
    expect(commandsIn(`the user: ${reason}`)).toEqual([]);
  });

  test("the probe runs before any preparation, and no prepare starts a database", async () => {
    const store = "contexts/c/src/adapters/out/drizzle/x.store.test.ts";
    const order: string[] = [];
    const nothing = (): PreparedTestService => ({ description: "preflight", env: {}, release: () => {} });
    const decision = storeTestPhaseDecision({
      phase: "green",
      storeTests: [store],
      probe: () => { order.push("probe"); return { available: true, endpoint: "unix:///run/docker.sock" }; },
      preflight: async () => { order.push("preflight"); return nothing(); },
    });
    if (decision.action !== "run" || decision.prepare === undefined) throw new Error("expected a run that prepares");
    await decision.prepare({ set: {}, unset: [] });
    expect(order).toEqual(["probe", "preflight"]);

    let preflights = 0;
    const refused = storeTestPhaseDecision({
      phase: "green",
      storeTests: [store],
      probe: () => ({ available: false, reason: "the container engine isn't running" }),
      preflight: async () => { preflights++; return nothing(); },
    });
    expect(refused.action).toBe("refuse");
    expect(preflights).toBe(0);

    // A persisting tree with no store tests: whatever it prepares starts no
    // database of the gate's own (the app smoke tests start their own).
    const docker: string[][] = [];
    const options = {
      phase: "green" as const,
      storeTests: [],
      smokeTests: ["apps/web/src/server/composition-root.test.ts"],
      persists: true,
      probe: () => ({ available: true as const, endpoint: "unix:///run/docker.sock" }),
      preflight: async () => nothing(),
      docker: (args: readonly string[]) => { docker.push([...args]); },
    };
    const persisting = storeTestPhaseDecision(options);
    expect(persisting.action).toBe("run");
    if (persisting.action === "run" && persisting.prepare !== undefined) await persisting.prepare({ set: {}, unset: [] });
    expect(docker.filter((args) => args[0] === "run")).toEqual([]);
  });
});

describe("storeTestDecision (ADR 2026-064)", () => {
  const down: ContainerRuntimeProbe = { available: false, reason: "no container runtime found" };
  const up: ContainerRuntimeProbe = { available: true, endpoint: "unix:///var/run/docker.sock" };
  const tests = ["contexts/pm/src/adapters/out/drizzle/notes/create-note.store.test.ts"];

  const unsetEnv = ["BOUNDED_STORE_TESTS_SKIP", "BOUNDED_STORE_TESTS_PHASE"];
  const leaked = { PATH: "/bin", BOUNDED_STORE_TESTS_SKIP: "stale reason", BOUNDED_STORE_TESTS_PHASE: "red" };

  test("no store tests, or green with a runtime that answers: run, removing any skip variable", () => {
    for (const phase of ["red", "green"] as const) {
      expect(storeTestDecision(phase, [], down)).toEqual({ action: "run", unsetEnv });
    }
    expect(storeTestDecision("green", tests, up)).toEqual({ action: "run", unsetEnv });
  });

  test("red skips the store tests even when the runtime answers: their migrations do not exist until after red", () => {
    const reason = "1 Drizzle store test file(s) skipped at red: they apply migrations that are generated from the builder's schema after red";
    expect(storeTestDecision("red", tests, up)).toEqual({
      action: "skip", reason, env: { BOUNDED_STORE_TESTS_SKIP: reason, BOUNDED_STORE_TESTS_PHASE: "red" },
    });
  });

  test("red without a runtime skips the store tests with the reason and the red token", () => {
    const reason = "1 Drizzle store test file(s) skipped at red: no container runtime found";
    expect(storeTestDecision("red", tests, down)).toEqual({
      action: "skip", reason, env: { BOUNDED_STORE_TESTS_SKIP: reason, BOUNDED_STORE_TESTS_PHASE: "red" },
    });
  });

  test("green without a runtime refuses, naming the tests and the fix, and never skips", () => {
    const decision = storeTestDecision("green", tests, down);
    expect(decision.action).toBe("refuse");
    expect((decision as { reason: string }).reason).toContain(tests[0]);
    expect((decision as { reason: string }).reason).toContain("Start Docker");
    expect(decision).toHaveProperty("unsetEnv", unsetEnv);
    expect(decision).not.toHaveProperty("env");
  });

  test("a skip variable leaked into green's environment never reaches the test child", () => {
    for (const probe of [up, down]) {
      const env = storeTestEnv(leaked, storeTestDecision("green", tests, probe));
      expect(env).toEqual({ PATH: "/bin" });
    }
    // Red's own skip replaces a stale reason with its own.
    expect(storeTestEnv(leaked, storeTestDecision("red", tests, down))).toEqual({
      PATH: "/bin", BOUNDED_STORE_TESTS_PHASE: "red",
      BOUNDED_STORE_TESTS_SKIP: "1 Drizzle store test file(s) skipped at red: no container runtime found",
    });
  });
});

describe("drizzleStoreTests", () => {
  test("lists test files under every context's drizzle adapter, not the generated support or other adapters", () => {
    const dir = home();
    const touch = (path: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), "");
    };
    touch("contexts/pm/src/adapters/out/drizzle/notes/create-note.store.test.ts");
    touch("contexts/pm/src/adapters/out/drizzle/notes/create-note.store.ts");
    touch("contexts/pm/src/adapters/out/drizzle/drizzle-test-database.test-support.ts");
    touch("contexts/pm/src/adapters/out/in-memory/notes/create-note.store.test.ts");
    touch("contexts/billing/src/adapters/out/drizzle/invoices/send-invoice.store.test.ts");
    touch("contexts/billing/node_modules/x/adapters/out/drizzle/a.test.ts");
    expect(drizzleStoreTests(dir)).toEqual([
      "contexts/billing/src/adapters/out/drizzle/invoices/send-invoice.store.test.ts",
      "contexts/pm/src/adapters/out/drizzle/notes/create-note.store.test.ts",
    ]);
    expect(drizzleStoreTests(home())).toEqual([]);
  });
});
