// The policy's decisions for a persisting tree with no gate database (issue
// #52, ADR 2026-072), and the gate's prepared-service mechanics: the
// environment the test process gets and release on every exit (signals
// included). No runtime needed.
import { describe, expect, test } from "vitest";
import { withPreparedServices } from "../ts/scripts/phase-policy.ts";
import type { PreparedTestService } from "../ts/pack.ts";
import { APP_DATABASE_ENV, runChild } from "./scripts/app-database.ts";
import { storeTestPhaseDecision } from "./scripts/container-runtime.ts";
import { POSTGRES_IMAGE } from "./scripts/emit.ts";

const SERVICE: PreparedTestService = { description: "x", env: {}, release: () => {} };
const SMOKE = "apps/web/src/server/composition-root.test.ts";

describe("the decision on a persisting tree (no Docker needed)", () => {
  const up = () => ({ available: true as const, endpoint: "unix:///run/docker.sock" });
  const down = () => ({ available: false as const, reason: "no container runtime found" });

  test("green with smoke tests and a runtime runs their preflight on the probed endpoint, and starts no database", async () => {
    const seen: string[] = [];
    const decision = storeTestPhaseDecision({
      phase: "green", storeTests: [], probe: up, persists: true, smokeTests: [SMOKE],
      preflight: async (endpoint, _env, files) => { seen.push(`${endpoint} ${files.join(",")}`); return SERVICE; },
    });
    expect(decision.action).toBe("run");
    if (decision.action !== "run") return;
    expect(seen).toEqual([]); // nothing starts while deciding
    const service = await decision.prepare!({ set: {}, unset: [] });
    expect(seen).toEqual([`unix:///run/docker.sock ${SMOKE}`]);
    expect(service.env).not.toHaveProperty(APP_DATABASE_ENV);
  });

  test("green without a runtime refuses, routed to the user, store tests or not", () => {
    for (const storeTests of [[], ["contexts/pm/src/adapters/out/drizzle/x.store.test.ts"]]) {
      const decision = storeTestPhaseDecision({ phase: "green", storeTests, probe: down, persists: true, smokeTests: [SMOKE] });
      expect(decision).toMatchObject({ action: "refuse", route: "user" });
      if (decision.action === "refuse") expect(decision.reason).toMatch(/isn't running: start it/);
    }
  });

  test("red never prepares, and a tree without Drizzle never probes", () => {
    const red = storeTestPhaseDecision({ phase: "red", storeTests: [], probe: up, persists: true, smokeTests: [SMOKE], preflight: async () => SERVICE });
    expect(red).toEqual({ action: "run", unsetEnv: expect.any(Array) });
    let probed = false;
    const plain = storeTestPhaseDecision({
      phase: "green", storeTests: [], probe: () => { probed = true; return up(); }, persists: false, smokeTests: [SMOKE], preflight: async () => SERVICE,
    });
    expect(plain).toEqual({ action: "run", unsetEnv: expect.any(Array) });
    expect(probed).toBe(false);
  });
});

describe("the environment and the release (no Docker needed)", () => {
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

describe("the pack's child processes (no Docker needed)", () => {
  test("a child is awaited, and killed and reported at its timeout", async () => {
    const quick = await runChild(process.execPath, ["-e", "console.log('hi')"], { timeoutMs: 10_000 });
    expect(quick).toMatchObject({ status: 0, stdout: "hi\n" });
    const slow = await runChild(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 });
    expect(slow.status).toBeNull();
    expect(slow.error?.message).toMatch(/timed out/);
  });

  test("the image is pinned by tag and digest", () => {
    expect(POSTGRES_IMAGE).toMatch(/^postgres:\d+\.\d+@sha256:[0-9a-f]{64}$/);
  });
});
