// Green's Testcontainers preflight and the infrastructure-failure classifier
// (ADR 2026-064, amended), without a container runtime: the cause
// classification and remedies, secret cleaning, the preflight's sequencing
// against a scripted child, the policy decision, and the green gate's
// routing of both to the orchestrator. The real-container cases live in
// store-integration.test.ts.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { logGuardEvent } from "../../src/guard-log.ts";
import type { PreparedTestService } from "../ts/pack.ts";
import { runGreenGate } from "../ts/scripts/green-gate.ts";
import { cannedGateEnv, type CannedCase, withEnv } from "../ts/scripts/junit-fixture.test-support.ts";
import { combineDecisions, withPreparedServices } from "../ts/scripts/phase-policy.ts";
import { pipelineProject, placeStage } from "../ts/scripts/pipeline-fixture.test-support.ts";
import { testFilesHash } from "../ts/scripts/red-gate.ts";
import { runTests } from "../ts/scripts/run-tests.ts";
import { runScaffold } from "../ts/scripts/scaffold-project.ts";
import { storeTestPhaseDecision } from "./scripts/container-runtime.ts";
import { POSTGRES_IMAGE } from "./scripts/emit.ts";
import {
  classifyPreflightFailure, cleanCause, type ClassifyContext, type PreflightDeps, preflightRefusal, preflightTestcontainers,
  readDockerConfig, recogniseInfrastructure, storeTestInfrastructureFailure,
} from "./scripts/testcontainers-preflight.ts";

const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
};

const HOME = "/Users/someone";
const CONTEXT: ClassifyContext = {
  image: POSTGRES_IMAGE,
  home: HOME,
  endpoint: "unix:///Users/someone/.orbstack/run/docker.sock",
  dockerConfig: { shownAs: "~/.docker/config.json", credsStore: "desktop" },
};

describe("recogniseInfrastructure: the cause and the remedy", () => {
  test("a missing credential helper names the config, the key and the helper, exactly", () => {
    for (const text of [
      "Error from Docker credential provider: Error: spawn docker-credential-desktop ENOENT",
      'Error from Docker credential provider: Error: Executable not found in $PATH: "docker-credential-desktop"',
    ]) {
      const found = recogniseInfrastructure(text, CONTEXT);
      expect(found?.kind).toBe("credential-helper");
      expect(found?.remedy).toBe(
        "~/.docker/config.json names credsStore 'desktop' but docker-credential-desktop is not on PATH: remove the line or install the helper",
      );
      expect(found?.cause).toContain("docker-credential-desktop");
    }
  });

  test("a helper named per registry says credHelpers, and a custom DOCKER_CONFIG is shown as such", () => {
    const found = recogniseInfrastructure("spawn docker-credential-ecr-login ENOENT", {
      ...CONTEXT, dockerConfig: { shownAs: "$DOCKER_CONFIG/config.json", credHelpers: { "123.dkr.ecr.aws": "ecr-login" } },
    });
    expect(found?.remedy).toBe(
      "$DOCKER_CONFIG/config.json names credHelpers '123.dkr.ecr.aws' → 'ecr-login' but docker-credential-ecr-login is not on PATH: remove the line or install the helper",
    );
  });

  test("no runtime strategy, a refused socket, a failed pull and a reaper that cannot start", () => {
    const noRuntime = recogniseInfrastructure("Error: Could not find a working container runtime strategy", CONTEXT);
    expect(noRuntime?.kind).toBe("no-runtime");
    expect(noRuntime?.remedy).toContain("unix://~/.orbstack/run/docker.sock");
    expect(noRuntime?.remedy).toContain("DOCKER_HOST");

    expect(recogniseInfrastructure("connect ECONNREFUSED /var/run/docker.sock", CONTEXT)?.kind).toBe("socket");
    expect(recogniseInfrastructure("connect EACCES /var/run/docker.sock", CONTEXT)?.remedy).toMatch(/permissions/);

    for (const text of [
      'Failed to pull image "postgres:17.6": (HTTP code 500) server error - Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io: no such host',
      "toomanyrequests: You have reached your pull rate limit",
      "getaddrinfo ENOTFOUND registry-1.docker.io",
    ]) {
      const pull = recogniseInfrastructure(text, CONTEXT);
      expect(pull?.kind).toBe("pull");
      expect(pull?.remedy).toContain(`docker pull ${POSTGRES_IMAGE}`);
    }

    const reaper = recogniseInfrastructure("Error: Ryuk container failed to start: port 8080 not bound", CONTEXT);
    expect(reaper?.kind).toBe("reaper");
    expect(reaper?.remedy).toContain("TESTCONTAINERS_RYUK_DISABLED=true");
  });

  test("an ordinary failure, and a bare ECONNREFUSED to the app's own port, are the code's", () => {
    expect(recogniseInfrastructure("AssertionError: expected 2 to be 3", CONTEXT)).toBeUndefined();
    expect(recogniseInfrastructure("NotImplementedError: Not implemented: DrizzleCreateProjectStore.save", CONTEXT)).toBeUndefined();
    expect(recogniseInfrastructure("connect ECONNREFUSED 127.0.0.1:5432", CONTEXT)).toBeUndefined();
  });
});

describe("classifyPreflightFailure", () => {
  test("a stage that ran out of time says which, and the pull gets its own remedy", () => {
    expect(classifyPreflightFailure("", "pull", true, CONTEXT)).toMatchObject({ kind: "pull", cause: `pulling ${POSTGRES_IMAGE} did not finish in time` });
    expect(classifyPreflightFailure("", "start", true, CONTEXT)).toMatchObject({ kind: "timeout", cause: "starting and stopping the container did not finish in time" });
  });

  test("anything unrecognised still refuses with the raw cause and a way to see the runtime's own error", () => {
    const found = classifyPreflightFailure("Error: (HTTP code 409) conflict", "start", false, CONTEXT);
    expect(found).toMatchObject({ kind: "other", cause: "Error: (HTTP code 409) conflict" });
    expect(found.remedy).toContain(`docker run --rm ${POSTGRES_IMAGE}`);
  });
});

describe("cleanCause: what the user sees", () => {
  test("drops stack frames and code frames, redacts credentials and the home directory, and stays one bounded line", () => {
    const text = [
      "Error: pull failed for https://bob:hunter2@registry.example.com/v2/",
      '{"password":"s3cret","auth":"Ym9iOmh1bnRlcjI=","identitytoken":"abc.def"} token=xyz',
      "Authorization: Bearer eyJhbGciOi.payload.sig",
      "    at pull (/Users/someone/project/node_modules/testcontainers/build/x.js:1:1)",
      "3 | await container.start();",
      "^",
      "while reading /Users/someone/.docker/config.json",
    ].join("\n");
    const cleaned = cleanCause(text, HOME);
    for (const secret of ["hunter2", "s3cret", "Ym9iOmh1bnRlcjI=", "abc.def", "xyz", "eyJhbGciOi", "/Users/someone"]) {
      expect(cleaned).not.toContain(secret);
    }
    expect(cleaned).toContain("://[redacted]@registry.example.com");
    expect(cleaned).toContain("~/.docker/config.json");
    expect(cleaned).not.toContain(" at pull");
    expect(cleaned).not.toContain("\n");
    expect(cleanCause("x".repeat(5000), HOME).length).toBeLessThanOrEqual(600);
  });
});

describe("readDockerConfig", () => {
  test("reads DOCKER_CONFIG when set, shown without its path; an absent or broken file names nothing", () => {
    const dir = tempDir("docker-config-");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ credsStore: "desktop", credHelpers: { "gcr.io": "gcloud" }, auths: {} }));
    expect(readDockerConfig({ DOCKER_CONFIG: dir }, HOME)).toEqual({ shownAs: "$DOCKER_CONFIG/config.json", credsStore: "desktop", credHelpers: { "gcr.io": "gcloud" } });
    expect(readDockerConfig({}, tempDir("home-"))).toEqual({ shownAs: "~/.docker/config.json" });
    writeFileSync(join(dir, "config.json"), "{ not json");
    expect(readDockerConfig({ DOCKER_CONFIG: dir }, HOME)).toEqual({ shownAs: "$DOCKER_CONFIG/config.json" });
  });
});

// --- the preflight's sequencing, against a scripted child ---------------------

function scriptedChild(lines: readonly string[], status: number | null, options: { timedOut?: boolean; stderr?: string } = {}) {
  const seen: { env?: NodeJS.ProcessEnv; cwd?: string; budgets: number[]; swept: string[] } = { budgets: [], swept: [] };
  const deps: PreflightDeps = {
    child: async (env, cwd, onLine, timeoutFor) => {
      seen.env = env;
      seen.cwd = cwd;
      seen.budgets.push(timeoutFor());
      for (const line of lines) {
        onLine(line);
        seen.budgets.push(timeoutFor());
      }
      return { status, stdout: "", stderr: options.stderr ?? "", timedOut: options.timedOut ?? false };
    },
    sweep: (run) => void seen.swept.push(run),
    suffix: () => "run1",
    env: { PATH: "/usr/bin", DOCKER_HOST: "unix:///custom.sock", TESTCONTAINERS_RYUK_DISABLED: "true", BUN_CONFIG_X: "1" },
    home: tempDir("home-"),
  };
  return { deps, seen };
}

const DONE = ['{"done":"runtime"}', '{"done":"pull"}', '{"done":"start"}'];

describe("preflightTestcontainers (no Docker needed)", () => {
  test("runs in the project, from the store tests' directory, in the test process's environment, each stage on its own clock", async () => {
    const { deps, seen } = scriptedChild(DONE, 0);
    const service = await preflightTestcontainers("/p", "contexts/pm/src/adapters/out/drizzle/x.store.test.ts", "unix:///probed.sock", deps);
    expect(service.env).toEqual({});
    expect(service.description).toContain(POSTGRES_IMAGE);
    expect(seen.cwd).toBe("/p");
    expect(seen.env).toMatchObject({
      BOUNDED_PREFLIGHT_FROM: "/p/contexts/pm/src/adapters/out/drizzle/x.store.test.ts",
      BOUNDED_PREFLIGHT_IMAGE: POSTGRES_IMAGE,
      // The test process's environment: DOCKER_HOST and the Ryuk switch untouched, BUN_* dropped.
      DOCKER_HOST: "unix:///custom.sock",
      TESTCONTAINERS_RYUK_DISABLED: "true",
      CI: "true",
    });
    expect(seen.env?.["BUN_CONFIG_X"]).toBeUndefined();
    expect(JSON.parse(seen.env?.["BOUNDED_PREFLIGHT_LABELS"] ?? "{}")).toEqual({ "dev.bounded.role": "green-testcontainers-preflight", "dev.bounded.preflight-run": "run1" });
    // runtime, then the pull's own generous clock, then the start's.
    expect(seen.budgets).toEqual([60_000, 600_000, 180_000, 180_000]);
    expect(seen.swept).toEqual(["run1"]);
  });

  test("a failure refuses with the classified cause, and the run's containers are swept", async () => {
    const { deps, seen } = scriptedChild(['{"done":"runtime"}', JSON.stringify({ failed: "pull", error: "Error from Docker credential provider: Error: spawn docker-credential-desktop ENOENT" })], 1);
    mkdirSync(join(deps.home, ".docker"));
    writeFileSync(join(deps.home, ".docker", "config.json"), JSON.stringify({ credsStore: "desktop" }));
    await expect(preflightTestcontainers("/p", "x.store.test.ts", "", { ...deps, env: { PATH: "/usr/bin" } })).rejects.toThrow(
      "Remedy: ~/.docker/config.json names credsStore 'desktop' but docker-credential-desktop is not on PATH: remove the line or install the helper.",
    );
    expect(seen.swept).toEqual(["run1"]);
  });

  test("a stage that times out refuses naming it; a child that cannot spawn says why; both sweep", async () => {
    const slow = scriptedChild(['{"done":"runtime"}'], null, { timedOut: true });
    await expect(preflightTestcontainers("/p", "x.store.test.ts", "", slow.deps)).rejects.toThrow(`pulling ${POSTGRES_IMAGE} did not finish in time`);
    expect(slow.seen.swept).toEqual(["run1"]);

    const thrown = scriptedChild([], 0);
    const deps: PreflightDeps = { ...thrown.deps, child: async () => { throw new Error("spawn failed"); } };
    await expect(preflightTestcontainers("/p", "x.store.test.ts", "", deps)).rejects.toThrow("spawn failed");
    expect(thrown.seen.swept).toEqual(["run1"]);
  });

  test("an exit 0 without the last stage is not a pass", async () => {
    const { deps } = scriptedChild(['{"done":"runtime"}', '{"done":"pull"}'], 0);
    await expect(preflightTestcontainers("/p", "x.store.test.ts", "", deps)).rejects.toThrow(/could not start/);
  });
});

// --- the policy decision ------------------------------------------------------

const STORE = "contexts/pm/src/adapters/out/drizzle/projects/create-project.store.test.ts";
const up = () => ({ available: true as const, endpoint: "unix:///run/docker.sock" });
const service = (description: string, released: string[], env: Record<string, string> = {}): PreparedTestService =>
  ({ description, env, release: () => void released.push(description) });

describe("the decision: the preflight runs before anything else at green, and only with store tests", () => {
  test("green with store tests: preflight, then the app database, on the probed endpoint, as one service", async () => {
    const order: string[] = [];
    const released: string[] = [];
    const decision = storeTestPhaseDecision("green", [STORE], up, true,
      async (endpoint) => { order.push(`database ${endpoint}`); return service("database", released, { DATABASE_URL: "postgres://x" }); },
      async (endpoint) => { order.push(`preflight ${endpoint}`); return service("preflight", released); },
      () => () => undefined,
    );
    if (decision.action !== "run") throw new Error("expected run");
    expect(order).toEqual([]);
    const started = await decision.prepare!();
    expect(order).toEqual(["preflight unix:///run/docker.sock", "database unix:///run/docker.sock"]);
    expect(started.env).toEqual({ DATABASE_URL: "postgres://x" });
    expect(started.description).toBe("preflight; database");
    started.release();
    expect(released).toEqual(["database", "preflight"]);
    expect(decision.infrastructureFailure).toBeTypeOf("function");
  });

  test("a failed preflight starts no database and refuses through withPreparedServices", async () => {
    let databases = 0;
    const decision = storeTestPhaseDecision("green", [STORE], up, true,
      async () => { databases++; return service("database", []); },
      async () => { throw new Error(preflightRefusal(recogniseInfrastructure("spawn docker-credential-desktop ENOENT", CONTEXT)!, POSTGRES_IMAGE)); },
    );
    const run = combineDecisions("green", [{ name: "store-tests-need-a-container-runtime", decision }]);
    let ran = false;
    const prepared = await withPreparedServices(run, async () => { ran = true; });
    expect(prepared.ok).toBe(false);
    expect(ran).toBe(false);
    expect(databases).toBe(0);
    if (!prepared.ok) expect(prepared.reason).toContain("docker-credential-desktop is not on PATH");
  });

  test("red, and a tree without store tests, never preflight and carry no classifier", () => {
    let preflights = 0;
    const preflight = async () => { preflights++; return service("preflight", []); };
    const red = storeTestPhaseDecision("red", [STORE], up, true, undefined, preflight, () => () => "x");
    expect(red.action).toBe("skip");
    const noStores = storeTestPhaseDecision("green", [], up, true, async () => service("database", []), preflight, () => () => "x");
    if (noStores.action !== "run") throw new Error("expected run");
    expect(noStores.infrastructureFailure).toBeUndefined();
    expect(preflights).toBe(0);
  });
});

describe("storeTestInfrastructureFailure: the defence in depth", () => {
  const classify = storeTestInfrastructureFailure([STORE], CONTEXT);

  test("claims a store test, or a failure no file claims, that failed because of the machine", () => {
    expect(classify({ name: "DrizzleCreateProjectStore > (unnamed)", file: STORE, message: "error: Error from Docker credential provider: Error: spawn docker-credential-desktop ENOENT" }))
      .toBe("DrizzleCreateProjectStore > (unnamed): error: Error from Docker credential provider: Error: spawn docker-credential-desktop ENOENT. " +
        "Remedy: ~/.docker/config.json names credsStore 'desktop' but docker-credential-desktop is not on PATH: remove the line or install the helper");
    expect(classify({ name: "unhandled error", message: "Could not find a working container runtime strategy" })).toMatch(/Testcontainers found no container runtime/);
  });

  test("leaves the code's failures, and the same text from another test file, to the roles", () => {
    expect(classify({ name: "DrizzleCreateProjectStore > saves", file: STORE, message: "AssertionError: expected 1 to be 2" })).toBeUndefined();
    expect(classify({ name: "Note > x", file: "contexts/pm/src/domain/note.test.ts", message: "spawn docker-credential-desktop ENOENT" })).toBeUndefined();
  });

  test("reads a real bun failure: a beforeAll that could not start the container fails the block, and the message survives sanitizing", async () => {
    const dir = tempDir("infra-run-");
    const file = join(dir, STORE);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{ "private": true, "type": "module" }\n');
    writeFileSync(file, [
      'import { beforeAll, describe, expect, test } from "bun:test";',
      'describe("DrizzleCreateProjectStore", () => {',
      "  beforeAll(async () => {",
      '    throw new Error("Error from Docker credential provider: Error: spawn docker-credential-desktop ENOENT");',
      "  });",
      '  test("saves", () => { expect(1).toBe(1); });',
      "});",
      "",
    ].join("\n"));
    const run = await runTests(dir, { env: { set: {}, unset: [] } });
    const failures = run.results.filter((r) => r.status === "failed");
    expect(failures.length).toBeGreaterThan(0);
    const causes = failures.map((r) => classify({ name: r.name, ...(r.message !== undefined ? { message: r.message } : {}), ...(r.file !== undefined ? { file: r.file } : {}) }));
    expect(causes.some((cause) => cause?.includes("docker-credential-desktop is not on PATH"))).toBe(true);
  }, 60_000);
});

// --- the green gate routes both to the orchestrator ----------------------------

const fixtures: { cleanup: () => void }[] = [];
afterAll(() => { for (const f of fixtures) f.cleanup(); });

function builtWithStandingRed(): string {
  const f = pipelineProject(["design"]);
  fixtures.push(f);
  expect(runScaffold(f.dir).code).toBe(0);
  placeStage(f.dir, "tests", f.scope);
  placeStage(f.dir, "build", f.scope);
  logGuardEvent(f.dir, { guard: "checksum-gate", verdict: "pass", summary: "wrote manifest (5 contract files)" });
  logGuardEvent(f.dir, { guard: "red-gate", verdict: "pass", summary: "RED OK", detail: { testFilesHash: testFilesHash(f.dir) } });
  return f.dir;
}

const PASSING: readonly CannedCase[] = [
  { name: "Note > equals", status: "passed" },
  { name: "CreateNoteHandler > creates the note and saves it", status: "passed" },
];

describe("the green gate (with fakes): the machine's failures go to the orchestrator, never a role", () => {
  test("a failed preflight refuses before any test runs, with the cause and the remedy", async () => {
    const dir = builtWithStandingRed();
    const marker = join(dir, ".suite-ran");
    const decision = storeTestPhaseDecision("green", [STORE], up, false, undefined,
      async () => { throw new Error(preflightRefusal(recogniseInfrastructure("spawn docker-credential-desktop ENOENT", CONTEXT)!, POSTGRES_IMAGE)); },
      () => storeTestInfrastructureFailure([STORE], CONTEXT),
    );
    const policy = combineDecisions("green", [{ name: "store-tests-need-a-container-runtime", decision }]);
    const env = { ...cannedGateEnv(dir, PASSING), BOUNDED_GATE_TEST_CMD: "sh", BOUNDED_GATE_TEST_ARGS: JSON.stringify(["-c", `touch '${marker}'; exit 1`]) };
    const r = await withEnv(env, () => runGreenGate(dir, { policy }));
    expect(r).toMatchObject({ code: 1, verdict: "block", detail: { reason: "test-policy", route: "orchestrator" } });
    expect(r.lines.at(-1)).toBe("green-gate: route → orchestrator");
    expect(r.lines.join("\n")).toContain("~/.docker/config.json names credsStore 'desktop' but docker-credential-desktop is not on PATH: remove the line or install the helper");
    expect(r.lines.join("\n")).not.toContain("route → builder");
    expect(existsSync(marker)).toBe(false);
  }, 120_000);

  test("a store test that still fails because of the machine routes to the orchestrator with the cause, not the builder", async () => {
    const dir = builtWithStandingRed();
    const decision = storeTestPhaseDecision("green", [STORE], up, false, undefined,
      async () => service("preflight", []),
      () => storeTestInfrastructureFailure([STORE], CONTEXT),
    );
    const policy = combineDecisions("green", [{ name: "store-tests-need-a-container-runtime", decision }]);
    const cases: CannedCase[] = [...PASSING, {
      name: "DrizzleCreateProjectStore > (unnamed)", status: "failed", file: STORE,
      message: "error: Failed to pull image \"postgres:17.6\": getaddrinfo ENOTFOUND registry-1.docker.io",
    }];
    const r = await withEnv(cannedGateEnv(dir, cases), () => runGreenGate(dir, { policy }));
    expect(r).toMatchObject({ code: 1, verdict: "block", detail: { reason: "infrastructure", route: "orchestrator" } });
    expect(r.lines.at(-1)).toBe("green-gate: route → orchestrator");
    expect(r.lines.join("\n")).toContain("the image could not be pulled");

    // The same run with an ordinary assertion failure is still the builder's.
    const ordinary = await withEnv(cannedGateEnv(dir, [...PASSING, { name: "DrizzleCreateProjectStore > saves", status: "failed", file: STORE, message: "error: expected 1 to be 2" }]),
      () => runGreenGate(dir, { policy }));
    expect(ordinary.lines).toContain("green-gate: route → builder");
  }, 120_000);
});
