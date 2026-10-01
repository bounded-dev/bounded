// The green run's throwaway application database: the policy decision, the
// environment the test process gets, release on every exit (signals
// included), and the cleanup/pull/start/wait/migrate/release sequence
// against a scripted docker (no runtime needed).
import { describe, expect, test } from "vitest";
import { withPreparedServices } from "../ts/scripts/phase-policy.ts";
import type { PreparedTestService } from "../ts/pack.ts";
import {
  APP_DATABASE_ENV,
  APP_DATABASE_LABEL,
  type AppDatabaseDeps,
  appDatabaseEnv,
  appDatabaseUrl,
  type CommandResult,
  orphanedContainers,
  publishedPort,
  PULL_TIMEOUT_MS,
  startAppDatabase,
} from "./scripts/app-database.ts";
import { storeTestPhaseDecision } from "./scripts/container-runtime.ts";
import { POSTGRES_IMAGE } from "./scripts/emit.ts";

const OK = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" });
const FAIL = (stderr: string): CommandResult => ({ status: 1, stdout: "", stderr });

/** A scripted docker: answers by subcommand, records every call. */
function scripted(answers: Partial<Record<string, CommandResult | CommandResult[]>>, migrated: CommandResult = OK()) {
  const calls: string[][] = [];
  const timeouts: Record<string, number> = {};
  const removed: string[] = [];
  const migrations: string[] = [];
  let clock = 0;
  const deps: AppDatabaseDeps = {
    docker: async (args, _endpoint, timeoutMs) => {
      calls.push([...args]);
      timeouts[args[0]!] = timeoutMs;
      const answer = answers[args[0]!];
      if (Array.isArray(answer)) return answer.shift() ?? OK();
      return answer ?? OK();
    },
    remove: (name) => void removed.push(name),
    migrate: async (_project, url) => {
      migrations.push(url);
      return migrated;
    },
    sleep: async () => { clock += 250; },
    now: () => clock,
    suffix: () => "abcd1234",
    alive: (pid) => pid === 100,
    pid: 100,
    host: "this-host",
  };
  return { deps, calls, timeouts, removed, migrations };
}

const SERVICE: PreparedTestService = { description: "x", env: {}, release: () => {} };

describe("the decision (no Docker needed)", () => {
  const up = () => ({ available: true as const, endpoint: "unix:///run/docker.sock" });
  const down = () => ({ available: false as const, reason: "no container runtime found" });

  test("green on a Drizzle tree with a runtime runs, and asks for the database on the probed endpoint", async () => {
    const endpoints: string[] = [];
    const decision = storeTestPhaseDecision("green", ["contexts/pm/src/adapters/out/drizzle/x.store.test.ts"], up, true, async (endpoint) => {
      endpoints.push(endpoint);
      return SERVICE;
    });
    expect(decision.action).toBe("run");
    if (decision.action !== "run") return;
    expect(endpoints).toEqual([]); // nothing starts while deciding
    await decision.prepare!();
    expect(endpoints).toEqual(["unix:///run/docker.sock"]);
  });

  test("green on a Drizzle tree without a runtime refuses with Start Docker, store tests or not", () => {
    for (const storeTests of [[], ["contexts/pm/src/adapters/out/drizzle/x.store.test.ts"]]) {
      const decision = storeTestPhaseDecision("green", storeTests, down, true, async () => SERVICE);
      expect(decision.action).toBe("refuse");
      if (decision.action === "refuse") expect(decision.reason).toMatch(/Start Docker/);
    }
  });

  test("red never starts a database, and a tree without Drizzle never asks for one", () => {
    const red = storeTestPhaseDecision("red", [], up, true, async () => SERVICE);
    expect(red).toEqual({ action: "run", unsetEnv: expect.any(Array) });
    let probed = false;
    const plain = storeTestPhaseDecision("green", [], () => { probed = true; return up(); }, false, async () => SERVICE);
    expect(plain).toEqual({ action: "run", unsetEnv: expect.any(Array) });
    expect(probed).toBe(false);
  });
});

describe("the environment and the release (no Docker needed)", () => {
  test("the database URL overrides an inherited DATABASE_URL, so a run never reaches a developer database", () => {
    const env = appDatabaseEnv({ [APP_DATABASE_ENV]: "postgres://me@localhost:5432/mine", PATH: "/bin" }, appDatabaseUrl(55001));
    expect(env[APP_DATABASE_ENV]).toBe("postgres://postgres:postgres@127.0.0.1:55001/app");
    expect(env["PATH"]).toBe("/bin");
  });

  test("a prepared service's env is set over the policies' own and survives their unset list", async () => {
    const seen: unknown[] = [];
    const service: PreparedTestService = { description: "db", env: { [APP_DATABASE_ENV]: "postgres://t" }, release: () => {} };
    const run = await withPreparedServices(
      { env: { set: { [APP_DATABASE_ENV]: "postgres://inherited" }, unset: [APP_DATABASE_ENV, "BOUNDED_STORE_TESTS_SKIP"] }, prepares: [{ name: "p", prepare: async () => service }] },
      async (env) => { seen.push(env); return 1; },
    );
    expect(run).toEqual({ ok: true, value: 1, lines: ["db"] });
    expect(seen).toEqual([{ set: { [APP_DATABASE_ENV]: "postgres://t" }, unset: ["BOUNDED_STORE_TESTS_SKIP"] }]);
  });

  test("every started service is released after the run, after a throw, and after a later start fails", async () => {
    const released: string[] = [];
    const service = (name: string): PreparedTestService => ({ description: name, env: {}, release: () => void released.push(name) });
    await expect(withPreparedServices({ env: { set: {}, unset: [] }, prepares: [{ name: "a", prepare: async () => service("a") }] },
      async () => { throw new Error("suite crashed"); })).rejects.toThrow("suite crashed");
    expect(released).toEqual(["a"]);
    let ran = false;
    const failed = await withPreparedServices({
      env: { set: {}, unset: [] },
      prepares: [{ name: "a", prepare: async () => service("a2") }, { name: "b", prepare: async () => { throw new Error("no image"); } }],
    }, async () => { ran = true; });
    expect(ran).toBe(false);
    expect(failed).toEqual({ ok: false, reason: "the 'b' test policy could not start what the run needs: no image" });
    expect(released).toEqual(["a", "a2"]);
  });

  test("SIGINT or SIGTERM during the run releases what was started, and the handlers are gone afterwards", async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const released: string[] = [];
      const before = process.listenerCount(signal);
      const kill = process.kill;
      const reraised: unknown[] = [];
      // The handler re-raises the signal after cleanup; catch that here.
      process.kill = ((pid: number, sig?: string | number) => { reraised.push([pid, sig]); return true; }) as typeof process.kill;
      try {
        await withPreparedServices(
          { env: { set: {}, unset: [] }, prepares: [{ name: "db", prepare: async () => ({ description: "db", env: {}, release: () => void released.push("db") }) }] },
          async () => {
            expect(process.listenerCount(signal)).toBe(before + 1);
            process.emit(signal, signal);
            expect(released).toEqual(["db"]);
          },
        );
      } finally {
        process.kill = kill;
      }
      expect(reraised).toEqual([[process.pid, signal]]);
      expect(released).toEqual(["db"]); // once, not again in finally
      expect(process.listenerCount(signal)).toBe(before);
    }
  });
});

describe("the start sequence against a scripted docker (no Docker needed)", () => {
  test("pulls the pinned image with its own timeout, then runs it labelled on a loopback port, waits for TCP readiness, migrates, hands over the URL", async () => {
    const { deps, calls, timeouts, migrations, removed } = scripted({ port: OK("127.0.0.1:55001\n"), exec: [FAIL("no response"), FAIL("no response"), OK()] });
    const service = await startAppDatabase("/p", "unix:///run/docker.sock", deps);
    expect(calls.map((c) => c[0])).toEqual(["ps", "pull", "run", "port", "exec", "exec", "exec"]);
    expect(calls[1]).toEqual(["pull", "--quiet", POSTGRES_IMAGE]);
    expect(timeouts["pull"]).toBe(PULL_TIMEOUT_MS);
    expect(timeouts["run"]).toBeLessThan(PULL_TIMEOUT_MS);
    const run = calls[2]!;
    expect(run).toContain(APP_DATABASE_LABEL);
    expect(run).toContain("dev.bounded.pid=100");
    expect(run).toContain("dev.bounded.host=this-host");
    expect(run).toContain("127.0.0.1::5432");
    expect(run.at(-1)).toBe(POSTGRES_IMAGE);
    expect(calls.find((c) => c[0] === "exec")).toContain("127.0.0.1");
    expect(migrations).toEqual(["postgres://postgres:postgres@127.0.0.1:55001/app"]);
    expect(service.env).toEqual({ [APP_DATABASE_ENV]: "postgres://postgres:postgres@127.0.0.1:55001/app" });
    service.release();
    service.release();
    expect(removed).toEqual(["bounded-green-db-abcd1234"]);
  });

  test("removes only labelled leftovers of this host whose process is gone, before starting", async () => {
    const listing = "old-1\t4242\tthis-host\nlive\t100\tthis-host\nelsewhere\t4242\tother-host\nunowned\t\t\n";
    expect(orphanedContainers(listing, "this-host", (pid) => pid === 100)).toEqual(["old-1"]);
    const { deps, calls, removed } = scripted({ ps: OK(listing), port: OK("127.0.0.1:55001") });
    await startAppDatabase("/p", "unix:///run/docker.sock", deps);
    expect(calls[0]).toContain("label=" + APP_DATABASE_LABEL);
    expect(removed).toEqual(["old-1"]);
  });

  test.each([
    ["the image cannot be pulled", { pull: FAIL("pull access denied") }, OK(), /could not pull postgres:.*: pull access denied/, []],
    ["docker run fails (it may still have created the container)", { run: FAIL("port is already allocated") }, OK(), /could not start a postgres:.* container/, ["bounded-green-db-abcd1234"]],
    ["no port is published", { port: FAIL("no public port") }, OK(), /published no port/, ["bounded-green-db-abcd1234"]],
    ["it never becomes ready", { port: OK("127.0.0.1:55001"), exec: FAIL("no response") }, OK(), /not ready within 90s/, ["bounded-green-db-abcd1234"]],
    ["the migrations fail", { port: OK("127.0.0.1:55001") }, FAIL("db-migrate: contexts/pm failed"), /migrations did not apply.*contexts\/pm failed/, ["bounded-green-db-abcd1234"]],
  ] as const)("refuses when %s, and removes the container by name", async (_, answers, migrated, reason, removals) => {
    const { deps, removed } = scripted({ ...answers }, migrated);
    await expect(startAppDatabase("/p", "unix:///run/docker.sock", deps)).rejects.toThrow(reason);
    expect(removed).toEqual(removals);
  });

  test("never blocks the event loop while it waits", async () => {
    const { deps } = scripted({ port: OK("127.0.0.1:55001"), exec: [FAIL("x"), OK()] });
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    await startAppDatabase("/p", "unix:///x.sock", { ...deps, sleep: (ms) => new Promise((r) => setTimeout(r, ms / 50)) });
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });

  test("reads the published port from docker port's output", () => {
    expect(publishedPort("0.0.0.0:49153\n[::]:49153\n")).toBe(49153);
    expect(publishedPort("127.0.0.1:55001")).toBe(55001);
    expect(publishedPort("[::]:49153")).toBeUndefined();
  });

  test("names a missing docker CLI plainly", async () => {
    const deps = scripted({}).deps;
    const missing: AppDatabaseDeps = { ...deps, docker: async () => ({ status: null, stdout: "", stderr: "", error: new Error("spawn docker ENOENT") }) };
    await expect(startAppDatabase("/p", "unix:///x.sock", missing)).rejects.toThrow(/the docker CLI is not on PATH/);
  });

  test("the image is pinned by tag and digest", () => {
    expect(POSTGRES_IMAGE).toMatch(/^postgres:\d+\.\d+@sha256:[0-9a-f]{64}$/);
  });
});

// The real container, against a generated context with its migrations, is in
// store-integration.test.ts, gated on a container runtime and the docker CLI.
