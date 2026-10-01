// The green run's throwaway application database: the policy decision, the
// environment the test process gets, and the start/wait/migrate/release
// sequence against a scripted docker (no runtime needed).
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
  publishedPort,
  startAppDatabase,
} from "./scripts/app-database.ts";
import { storeTestPhaseDecision } from "./scripts/container-runtime.ts";
import { POSTGRES_IMAGE } from "./scripts/emit.ts";

const OK = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" });
const FAIL = (stderr: string): CommandResult => ({ status: 1, stdout: "", stderr });

/** A scripted docker: answers by subcommand, records every call. */
function scripted(answers: Partial<Record<string, CommandResult | CommandResult[]>>, migrateCode = 0) {
  const calls: string[][] = [];
  const migrations: string[] = [];
  let clock = 0;
  const deps: AppDatabaseDeps = {
    docker: (args) => {
      calls.push([...args]);
      const answer = answers[args[0]!];
      if (Array.isArray(answer)) return answer.shift() ?? OK();
      return answer ?? OK();
    },
    migrate: (_project, url) => {
      migrations.push(url);
      return { code: migrateCode, output: migrateCode === 0 ? "" : "db-migrate: contexts/pm failed (exit 1)" };
    },
    sleep: () => { clock += 250; },
    now: () => clock,
    suffix: () => "abcd1234",
  };
  return { deps, calls, migrations };
}

const SERVICE: PreparedTestService = { description: "x", env: {}, release: () => {} };

describe("the decision (no Docker needed)", () => {
  const up = () => ({ available: true as const, endpoint: "unix:///run/docker.sock" });
  const down = () => ({ available: false as const, reason: "no container runtime found" });

  test("green on a Drizzle tree with a runtime runs, and asks for the database on the probed endpoint", () => {
    const endpoints: string[] = [];
    const decision = storeTestPhaseDecision("green", ["contexts/pm/src/adapters/out/drizzle/x.store.test.ts"], up, true, (endpoint) => {
      endpoints.push(endpoint);
      return SERVICE;
    });
    expect(decision.action).toBe("run");
    if (decision.action !== "run") return;
    expect(decision.prepare).toBeDefined();
    expect(endpoints).toEqual([]); // nothing starts while deciding
    decision.prepare!();
    expect(endpoints).toEqual(["unix:///run/docker.sock"]);
  });

  test("green on a Drizzle tree without a runtime refuses with Start Docker, store tests or not", () => {
    for (const storeTests of [[], ["contexts/pm/src/adapters/out/drizzle/x.store.test.ts"]]) {
      const decision = storeTestPhaseDecision("green", storeTests, down, true, () => SERVICE);
      expect(decision.action).toBe("refuse");
      if (decision.action === "refuse") expect(decision.reason).toMatch(/Start Docker/);
    }
  });

  test("red never starts a database, and a tree without Drizzle never asks for one", () => {
    const red = storeTestPhaseDecision("red", [], up, true, () => SERVICE);
    expect(red).toEqual({ action: "run", unsetEnv: expect.any(Array) });
    let probed = false;
    const plain = storeTestPhaseDecision("green", [], () => { probed = true; return up(); }, false, () => SERVICE);
    expect(plain).toEqual({ action: "run", unsetEnv: expect.any(Array) });
    expect(probed).toBe(false);
  });
});

describe("the environment (no Docker needed)", () => {
  test("the database URL overrides an inherited DATABASE_URL, so a run never reaches a developer database", () => {
    const env = appDatabaseEnv({ [APP_DATABASE_ENV]: "postgres://me@localhost:5432/mine", PATH: "/bin" }, appDatabaseUrl(55001));
    expect(env[APP_DATABASE_ENV]).toBe("postgres://postgres:postgres@127.0.0.1:55001/app");
    expect(env["PATH"]).toBe("/bin");
  });

  test("a prepared service's env is set over the policies' own and survives their unset list", async () => {
    const seen: unknown[] = [];
    const service: PreparedTestService = { description: "db", env: { [APP_DATABASE_ENV]: "postgres://t" }, release: () => {} };
    const run = await withPreparedServices(
      { env: { set: { [APP_DATABASE_ENV]: "postgres://inherited" }, unset: [APP_DATABASE_ENV, "BOUNDED_STORE_TESTS_SKIP"] }, prepares: [{ name: "p", prepare: () => service }] },
      async (env) => { seen.push(env); return 1; },
    );
    expect(run).toEqual({ ok: true, value: 1, lines: ["db"] });
    expect(seen).toEqual([{ set: { [APP_DATABASE_ENV]: "postgres://t" }, unset: ["BOUNDED_STORE_TESTS_SKIP"] }]);
  });

  test("every started service is released after the run, after a throw, and after a later start fails", async () => {
    const released: string[] = [];
    const service = (name: string): PreparedTestService => ({ description: name, env: {}, release: () => void released.push(name) });
    await expect(withPreparedServices({ env: { set: {}, unset: [] }, prepares: [{ name: "a", prepare: () => service("a") }] },
      async () => { throw new Error("suite crashed"); })).rejects.toThrow("suite crashed");
    expect(released).toEqual(["a"]);
    let ran = false;
    const failed = await withPreparedServices({
      env: { set: {}, unset: [] },
      prepares: [{ name: "a", prepare: () => service("a2") }, { name: "b", prepare: () => { throw new Error("no image"); } }],
    }, async () => { ran = true; });
    expect(ran).toBe(false);
    expect(failed).toEqual({ ok: false, reason: "the 'b' test policy could not start what the run needs: no image" });
    expect(released).toEqual(["a", "a2"]);
  });
});

describe("the start sequence against a scripted docker (no Docker needed)", () => {
  test("runs the pinned image on a loopback port with a label, waits for TCP readiness, migrates, and hands over the URL", () => {
    const { deps, calls, migrations } = scripted({ port: OK("127.0.0.1:55001\n"), exec: [FAIL("no response"), FAIL("no response"), OK()] });
    const service = startAppDatabase("/p", "unix:///run/docker.sock", deps);
    const run = calls[0]!;
    expect(run.slice(0, 2)).toEqual(["run", "--detach"]);
    expect(run).toContain(APP_DATABASE_LABEL);
    expect(run).toContain("127.0.0.1::5432");
    expect(run.at(-1)).toBe(POSTGRES_IMAGE);
    expect(calls.filter((c) => c[0] === "exec")).toHaveLength(3);
    expect(calls.find((c) => c[0] === "exec")).toContain("127.0.0.1");
    expect(migrations).toEqual(["postgres://postgres:postgres@127.0.0.1:55001/app"]);
    expect(service.env).toEqual({ [APP_DATABASE_ENV]: "postgres://postgres:postgres@127.0.0.1:55001/app" });
    service.release();
    service.release();
    expect(calls.filter((c) => c[0] === "rm")).toEqual([["rm", "--force", "--volumes", "bounded-green-db-abcd1234"]]);
  });

  test.each([
    ["the image cannot start", { run: FAIL("pull access denied") }, 0, /could not start a postgres:.* container: pull access denied/, 0],
    ["no port is published", { port: FAIL("no public port") }, 0, /published no port/, 1],
    ["it never becomes ready", { port: OK("127.0.0.1:55001"), exec: FAIL("no response") }, 0, /not ready within 90s/, 1],
    ["the migrations fail", { port: OK("127.0.0.1:55001") }, 1, /migrations did not apply/, 1],
  ] as const)("refuses when %s, and removes whatever it started", (_, answers, migrateCode, reason, removals) => {
    const { deps, calls } = scripted({ ...answers }, migrateCode);
    expect(() => startAppDatabase("/p", "unix:///run/docker.sock", deps)).toThrow(reason);
    expect(calls.filter((c) => c[0] === "rm")).toHaveLength(removals);
  });

  test("reads the published port from docker port's output", () => {
    expect(publishedPort("0.0.0.0:49153\n[::]:49153\n")).toBe(49153);
    expect(publishedPort("127.0.0.1:55001")).toBe(55001);
    expect(publishedPort("[::]:49153")).toBeUndefined();
  });

  test("names a missing docker CLI plainly", () => {
    const deps = scripted({}).deps;
    const missing: AppDatabaseDeps = { ...deps, docker: () => ({ status: null, stdout: "", stderr: "", error: new Error("spawnSync docker ENOENT") }) };
    expect(() => startAppDatabase("/p", "unix:///x.sock", missing)).toThrow(/the docker CLI is not on PATH/);
  });
});

// The real container, against a generated context with its migrations, is in
// store-integration.test.ts, gated on a container runtime and the docker CLI.
