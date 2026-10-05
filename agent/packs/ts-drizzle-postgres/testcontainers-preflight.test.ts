// Green's Testcontainers preflight and the infrastructure-failure classifier
// (ADR 2026-064, amended), without a container runtime: the cause
// classification and remedies, secret cleaning, the preflight's sequencing
// against a scripted child, the policy decision, and the green gate's
// routing of both to the orchestrator. The real-container cases live in
// store-integration.test.ts.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as realSleep } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { logGuardEvent } from "../../src/guard-log.ts";
import { commandsIn } from "../../test/fixtures/user-steps.ts";
import type { CommandResult } from "./scripts/app-database.ts";
import { type PreparedTestService, userRoutedError } from "../ts/pack.ts";
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
  preflightAllStoreTests, preflightTargets, SWEEP_GRACE_MS, preflightChild, type ChildResult, type InfrastructureKind,
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
const HELPER = "the container engine's settings name a registry login helper that isn't installed: install it, or remove it from the engine's settings";
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
        `${HELPER} (~/.docker/config.json names credsStore 'desktop', and docker-credential-desktop is not installed)`,
      );
      expect(found?.cause).toContain("docker-credential-desktop");
    }
  });

  test("a helper named per registry says credHelpers, and a custom DOCKER_CONFIG is shown as such", () => {
    const found = recogniseInfrastructure("spawn docker-credential-ecr-login ENOENT", {
      ...CONTEXT, dockerConfig: { shownAs: "$DOCKER_CONFIG/config.json", credHelpers: { "123.dkr.ecr.aws": "ecr-login" } },
    });
    expect(found?.remedy).toBe(
      `${HELPER} ($DOCKER_CONFIG/config.json names credHelpers '123.dkr.ecr.aws' → 'ecr-login', and docker-credential-ecr-login is not installed)`,
    );
  });

  test("no runtime strategy, a refused socket, a failed pull and a reaper that cannot start", () => {
    const noRuntime = recogniseInfrastructure("Error: Could not find a working container runtime strategy", CONTEXT);
    expect(noRuntime?.kind).toBe("no-runtime");
    expect(noRuntime?.remedy).toContain("unix://~/.orbstack/run/docker.sock");
    expect(noRuntime?.remedy).toContain("the container engine isn't running: start it");

    expect(recogniseInfrastructure("connect ECONNREFUSED /var/run/docker.sock", CONTEXT)?.kind).toBe("socket");
    expect(recogniseInfrastructure("connect EACCES /var/run/docker.sock", CONTEXT)?.remedy).toMatch(/can't reach the container engine: restart it/);

    for (const text of [
      'Failed to pull image "postgres:17.6": (HTTP code 500) server error - Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io: no such host',
      "toomanyrequests: You have reached your pull rate limit",
      "getaddrinfo ENOTFOUND registry-1.docker.io",
    ]) {
      const pull = recogniseInfrastructure(text, CONTEXT);
      expect(pull?.kind).toBe("pull");
      expect(pull?.remedy).toBe("the container engine can't fetch images: check your network and registry login");
    }

    for (const text of [
      "Error: Failed to connect to Reaper",
      '(HTTP code 404) no such image - No such image: testcontainers/ryuk:0.14.0',
    ]) {
      const reaper = recogniseInfrastructure(text, CONTEXT);
      expect(reaper?.kind).toBe("reaper");
      expect(reaper?.remedy).toContain("allow it in the engine's settings");
    }
  });

  // The review's repro: every one of these is a builder bug, and the
  // classifier is only the backstop, so each stays with the builder.
  test.each([
    ["bad SQL", 'error: syntax error at or near "SELEC"'],
    ["wrong mapper", 'expect(received).toEqual(expected) - "total": 10 + "total": "10"'],
    ["pg ECONNREFUSED 5432", "connect ECONNREFUSED 127.0.0.1:5432"],
    ["builder-built host typo", "getaddrinfo ENOTFOUND postgress"],
    ["builder host.docker.internal", "getaddrinfo ENOTFOUND host.docker.internal"],
    ["pg ECONNREFUSED port 23755", "connect ECONNREFUSED 127.0.0.1:23755"],
    ["domain error 'denied: '", "Error: Access denied: order 42 belongs to another customer"],
    ["domain error 'unauthorized: '", "DomainError: Unauthorized: customer cannot cancel a shipped order"],
    ["pg ECONNREFUSED with docker in the message", "connect ECONNREFUSED 127.0.0.1:5432 while connecting to postgres in docker"],
    ["builder throws mentioning ryuk", "expected 'ryuk-batch' to equal 'ryuk-batch-2'"],
    ["pg timeout", "Connection terminated due to connection timeout"],
  ])("a builder bug stays the builder's: %s", (_label, message) => {
    const classify = storeTestInfrastructureFailure(["contexts/orders/store.test.ts"], CONTEXT);
    expect(classify({ name: "x", message, file: "contexts/orders/store.test.ts" })).toBeUndefined();
    expect(recogniseInfrastructure(message, CONTEXT)).toBeUndefined();
  });

  test("the review's repro: a failure no file claims, and one in another test file, are not claimed for a host lookup", () => {
    const classify = storeTestInfrastructureFailure(["contexts/orders/store.test.ts"], CONTEXT);
    expect(classify({ name: "unhandled error", message: "getaddrinfo ENOTFOUND db" })).toBeUndefined();
    expect(classify({ name: "x", message: "getaddrinfo ENOTFOUND db", file: "apps/api/smoke.test.ts" })).toBeUndefined();
  });

  test("a failure no file claims gets only Testcontainers' own words", () => {
    const classify = storeTestInfrastructureFailure([STORE], CONTEXT);
    expect(classify({ name: "unhandled error", message: "Error from Docker credential provider: Error: spawn docker-credential-desktop ENOENT" })).toBeDefined();
    expect(classify({ name: "unhandled error", message: "Could not find a working container runtime strategy" })).toBeDefined();
    for (const message of ["spawn docker-credential-desktop ENOENT", "connect ECONNREFUSED /var/run/docker.sock", "toomanyrequests: You have reached your pull rate limit", "Failed to connect to Reaper"]) {
      expect(classify({ name: "unhandled error", message })).toBeUndefined();
      expect(classify({ name: "x", message, file: STORE })).toBeDefined();
    }
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
    expect(found.remedy).toBe("the container engine couldn't start the test database: restart it");
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
    expect(cleaned).toContain("while reading [path]");
    expect(cleaned).not.toContain(" at pull");
    expect(cleaned).not.toContain("\n");
    expect(cleanCause("x".repeat(5000), HOME).length).toBeLessThanOrEqual(600);
  });
});

describe("cleanCause: the review's repro", () => {
  test("URL, environment-style and JSON secrets, and machine paths", () => {
    expect(cleanCause('postgres://admin:hunter2@db:5432/x PGPASSWORD=hunter2 password: hunter2 {"auth":"dXNlcjpwYXNz"} /Users/x/proj/a.ts', "/Users/x"))
      .toBe('postgres://[redacted]@db:5432/x PGPASSWORD=[redacted] password: [redacted] {"auth":"[redacted]"} [path]');
  });

  test("a URL password containing @ is redacted up to the last @ before the host", () => {
    expect(cleanCause("connection string postgresql://user:p@ss@w0rd@localhost/db", "/Users/x")).toBe("connection string postgresql://[redacted]@localhost/db");
  });

  test("prefixed tokens, any-case secret names, api keys, and temp and home paths of any user", () => {
    const cleaned = cleanCause(
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789 AWS_SECRET_ACCESS_KEY=abc api_key=sk-123 /private/var/folders/ab/T/x /home/runner/w " +
        "gho_abcdefghijklmnopqrstu github_pat_11ABCDEFG0123456789_abcdef db_password=pw1 x-api-key: k2 /var/folders/zz/T/y /tmp/bounded-x " +
        `${tmpdir()}/bounded-run-1/stdout`,
      "/Users/x",
    );
    expect(cleaned).toBe(
      "[redacted] AWS_SECRET_ACCESS_KEY=[redacted] api_key=[redacted] [path] [path] [redacted] [redacted] db_password=[redacted] " +
        "x-api-key: [redacted] [path] [path] [path]",
    );
  });

  test("a value separated by a space from a secret flag or environment name (issue #37)", () => {
    expect(cleanCause("psql --password hunter2 -h db --db-token=t1 --api-key k2", HOME))
      .toBe("psql --password [redacted] -h db --db-token=[redacted] --api-key [redacted]");
    expect(cleanCause("env PGPASSWORD hunter2 POSTGRES_PASSWORD 'two words' DB_PASS x1 psql", HOME))
      .toBe("env PGPASSWORD [redacted] POSTGRES_PASSWORD [redacted] DB_PASS [redacted] psql");
    expect(cleanCause("docker login -u bob -p hunter2 registry.example.com", HOME))
      .toBe("docker login -u bob -p [redacted] registry.example.com");
  });

  test("pass= and pwd=, quoted values with spaces, and URL passwords with unencoded spaces (issue #37)", () => {
    expect(cleanCause("pass=hunter2 pwd=hunter2 db_pass=x PG_PWD: y", HOME))
      .toBe("pass=[redacted] pwd=[redacted] db_pass=[redacted] PG_PWD: [redacted]");
    expect(cleanCause(`password="correct horse battery" secret='a b' {"token": "x y"} next`, HOME))
      .toBe(`password="[redacted]" secret='[redacted]' {"token": "[redacted]"} next`);
    expect(cleanCause("postgres://user:pa ss word@db:5432/x tail", HOME)).toBe("postgres://[redacted]@db:5432/x tail");
    expect(cleanCause("postgresql://user:p@ss w0rd@localhost/db", HOME)).toBe("postgresql://[redacted]@localhost/db");
  });

  test("absolute machine paths outside home and the temp directory (issue #37)", () => {
    expect(cleanCause("ENOENT /opt/app/node_modules/x.js while loading (/workspace/proj/src/a.ts:3:4) from /srv/data", HOME))
      .toBe("ENOENT [path] while loading ([path]) from [path]");
    expect(cleanCause("cannot open Error:/srv/postgresql/pg_hba.conf", HOME)).toBe("cannot open Error:[path]");
    expect(cleanCause("lstat /mnt/c/Users/bob/proj: no such file", HOME)).toBe("lstat [path]: no such file");
  });

  test("secret names are whole tokens; an error's own word after a colon is not a value (review of #37)", () => {
    for (const text of [
      'Error response from daemon: Get "https://registry-1.docker.io/v2/": unauthorized: incorrect username or password',
      "error from registry: auth: unauthorized",
      "token: invalid",
      "key mismatch in image manifest",
    ]) expect(cleanCause(text, HOME)).toBe(text);
    expect(cleanCause("auth: dXNlcjpwYXNz token=invalid --password=hunter2", HOME))
      .toBe("auth: [redacted] token=[redacted] --password=[redacted]");
  });

  test("an Authorization header loses its scheme and its credential (review of #37)", () => {
    expect(cleanCause("Authorization: Token abcdef123456 next", HOME)).toBe("Authorization: [redacted] next");
    expect(cleanCause("authorization: Bearer abc.def", HOME)).toBe("authorization: [redacted]");
    expect(cleanCause("Proxy-Authorization: Basic Ym9iOmh1bnRlcjI=", HOME)).toBe("Proxy-Authorization: [redacted]");
    expect(cleanCause("Authorization: token=abc", HOME)).toBe("Authorization: [redacted]");
    expect(cleanCause('{"Authorization":"Token abc"}', HOME)).toBe('{"Authorization":"[redacted]"}');
  });

  test("upper-case prose after a secret's name stays as written (review of #37)", () => {
    for (const text of ["PASSWORD AUTHENTICATION FAILED FOR USER bob", "TOKEN EXPIRED", "API_KEY header missing", "API_KEY header was missing"]) {
      expect(cleanCause(text, HOME)).toBe(text);
    }
    expect(cleanCause("PGPASSWORD HUNTER2 psql", HOME)).toBe("PGPASSWORD [redacted] psql");
  });

  test("system directories stay as written; user and project paths do not (review of #37)", () => {
    for (const text of [
      "credential helper docker-credential-desktop not found in /usr/local/bin",
      "use /usr/bin/docker",
      "mkdir /var/lib/docker/overlay2: read-only file system",
      "open /etc/docker/daemon.json: permission denied",
    ]) expect(cleanCause(text, HOME)).toBe(text);
    expect(cleanCause("dial unix /Users/someone/.orbstack/run/docker.sock: no such file /opt/work/project/a.ts:1:2", HOME))
      .toBe("dial unix [path]: no such file [path]");
  });

  test("ordinary error text, well-known paths and port flags stay as written (issue #37)", () => {
    for (const text of [
      'password authentication failed for user "test"',
      "You must specify POSTGRES_PASSWORD to a non-empty value",
      "--password is required; use --password-stdin registry.example.com",
      "tests passed: 3, bypass: on",
      "docker run -p 5432:5432 postgres:16",
      "and/or TCP/IP 5432/tcp N/A docker.io/library/postgres:16",
      "connect ECONNREFUSED /var/run/docker.sock",
      "connect ENOENT /run/user/1000/podman/podman.sock",
      "unix:///var/run/docker.sock",
      "GET /v1.43/containers/create failed",
      'Get "https://registry-1.docker.io/v2/library/postgres/manifests/16"',
      "/opt alone, ~/.docker/config.json",
    ]) expect(cleanCause(text, HOME)).toBe(text);
  });

  test("leaves the shape of a Docker error readable", () => {
    expect(cleanCause('Error from Docker credential provider: Error: Executable not found in $PATH: "docker-credential-desktop"', HOME))
      .toBe('Error from Docker credential provider: Error: Executable not found in $PATH: "docker-credential-desktop"');
    expect(cleanCause("connect ECONNREFUSED /var/run/docker.sock", HOME)).toBe("connect ECONNREFUSED /var/run/docker.sock");
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
  const seen: { env?: NodeJS.ProcessEnv; cwd?: string; budgets: number[]; swept: string[]; events: string[] } = { budgets: [], swept: [], events: [] };
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
    sweep: (run, host) => { seen.swept.push(run); seen.events.push(`sweep ${host}`); },
    sleep: async (ms) => void seen.events.push(`sleep ${ms}`),
    suffix: () => "run1",
    env: { PATH: "/usr/bin", DOCKER_HOST: "unix:///custom.sock", TESTCONTAINERS_RYUK_DISABLED: "true", BUN_CONFIG_X: "1" },
    home: tempDir("home-"),
  };
  return { deps, seen };
}

const DONE = ['{"done":"runtime","host":"unix:///tc/resolved.sock"}', '{"done":"pull"}', '{"done":"start"}'];

describe("preflightTestcontainers (no Docker needed)", () => {
  test("runs in the project, from the store tests' directory, in the test process's environment, each stage on its own clock", async () => {
    const { deps, seen } = scriptedChild(DONE, 0);
    const service = await preflightTestcontainers("/p", "contexts/pm/src/adapters/out/drizzle/x.store.test.ts", "unix:///probed.sock", deps, {
      // The policies' change, applied exactly as the test process gets it.
      change: { set: { DATABASE_URL: "postgres://throwaway" }, unset: ["TESTCONTAINERS_RYUK_DISABLED"] },
    });
    expect(service.env).toEqual({});
    expect(service.description).toContain(POSTGRES_IMAGE);
    expect(seen.cwd).toBe("/p");
    expect(seen.env).toMatchObject({
      BOUNDED_PREFLIGHT_FROM: "/p/contexts/pm/src/adapters/out/drizzle/x.store.test.ts",
      BOUNDED_PREFLIGHT_IMAGE: POSTGRES_IMAGE,
      // The test process's environment: DOCKER_HOST and the Ryuk switch untouched, BUN_* dropped.
      DOCKER_HOST: "unix:///custom.sock",
      DATABASE_URL: "postgres://throwaway",
      CI: "true",
    });
    expect(seen.env?.["BUN_CONFIG_X"]).toBeUndefined();
    expect(seen.env?.["TESTCONTAINERS_RYUK_DISABLED"]).toBeUndefined();
    expect(JSON.parse(seen.env?.["BOUNDED_PREFLIGHT_LABELS"] ?? "{}")).toEqual({ "dev.bounded.role": "green-testcontainers-preflight", "dev.bounded.preflight-run": "run1" });
    // runtime, then the pull's stall clock (re-armed by its progress), then the start's.
    expect(seen.budgets).toEqual([60_000, 60_000, 180_000, 180_000]);
    // Swept on the runtime Testcontainers reported using, not the probed one; a clean exit needs no grace sweep.
    expect(seen.events).toEqual(["sweep unix:///tc/resolved.sock"]);
  });

  test("a failure refuses with the classified cause, and the run's containers are swept", async () => {
    const { deps, seen } = scriptedChild(['{"done":"runtime"}', JSON.stringify({ failed: "pull", error: "Error from Docker credential provider: Error: spawn docker-credential-desktop ENOENT" })], 1);
    mkdirSync(join(deps.home, ".docker"));
    writeFileSync(join(deps.home, ".docker", "config.json"), JSON.stringify({ credsStore: "desktop" }));
    await expect(preflightTestcontainers("/p", "x.store.test.ts", "", { ...deps, env: { PATH: "/usr/bin" } })).rejects.toThrow(
      `Remedy: ${HELPER} (~/.docker/config.json names credsStore 'desktop', and docker-credential-desktop is not installed).`,
    );
    expect(seen.events).toEqual(["sweep "]); // no host reported: the environment's default runtime
  });

  test("a stage that times out refuses naming it; a child that cannot spawn says why; both sweep", async () => {
    const slow = scriptedChild(['{"done":"runtime","host":"tcp://10.0.0.5:2375"}'], null, { timedOut: true });
    await expect(preflightTestcontainers("/p", "x.store.test.ts", "unix:///probed.sock", slow.deps)).rejects.toThrow(`pulling ${POSTGRES_IMAGE} did not finish in time`);
    // Killed: swept now, and again after a grace period for a create still in flight.
    expect(slow.seen.events).toEqual(["sweep tcp://10.0.0.5:2375", `sleep ${SWEEP_GRACE_MS}`, "sweep tcp://10.0.0.5:2375"]);

    const thrown = scriptedChild([], 0);
    const deps: PreflightDeps = { ...thrown.deps, child: async () => { throw new Error("spawn failed"); } };
    await expect(preflightTestcontainers("/p", "x.store.test.ts", "", deps)).rejects.toThrow("spawn failed");
    expect(thrown.seen.swept).toEqual(["run1", "run1"]);
  });

  test("an exit 0 without the last stage is not a pass", async () => {
    const { deps } = scriptedChild(['{"done":"runtime"}', '{"done":"pull"}'], 0);
    await expect(preflightTestcontainers("/p", "x.store.test.ts", "", deps)).rejects.toThrow(/could not start/);
  });
});

// --- issue #52: no preparation outlives the host's call ------------------------
//
// A hung engine answered the probe's ping and then stalled every later stage:
// over half an hour of silent waiting inside one host command. Each stage now
// runs on a clock that fits what is left of the call, the pull's clock is a
// stall clock re-armed by each line of Testcontainers' own pull progress, and
// a stage whose minimum no longer fits is refused before it starts.

/** A child runner (runChild's shape) playing `steps` on the (fake) clock:
 *  each line at its time after the spawn, then an exit 0 at `exitAt`. A kill
 *  records when it happened and ends the child with no status. */
function timedRunner(steps: readonly { readonly at: number; readonly line: string }[], exitAt = Number.MAX_SAFE_INTEGER) {
  let spawned!: () => void;
  const ready = new Promise<void>((resolve) => { spawned = resolve; });
  const seen: { killedAt?: number } = {};
  const runner = (_command: string, _args: readonly string[], options: { onSpawn?: (child: ChildProcess) => void }): Promise<CommandResult> =>
    new Promise((resolve) => {
      const stdout = new EventEmitter();
      const timers: ReturnType<typeof setTimeout>[] = [];
      const finish = (status: number | null): void => {
        for (const timer of timers) clearTimeout(timer);
        resolve({ status, stdout: "", stderr: "" });
      };
      options.onSpawn?.({ stdout, kill: () => { seen.killedAt = Date.now(); finish(null); return true; } } as unknown as ChildProcess);
      for (const step of steps) timers.push(setTimeout(() => stdout.emit("data", Buffer.from(`${step.line}\n`)), step.at));
      if (exitAt < Number.MAX_SAFE_INTEGER) timers.push(setTimeout(() => finish(0), exitAt));
      spawned();
    });
  return { runner, ready, seen };
}

/** The preflight's deps with the real preflightChild over a timed runner, on
 *  the fake clock. */
function onFakeClock(steps: readonly { readonly at: number; readonly line: string }[], exitAt?: number) {
  const timed = timedRunner(steps, exitAt);
  const results: ChildResult[] = [];
  const deps: PreflightDeps = {
    ...scriptedChild([], 0).deps,
    now: () => Date.now(),
    sleep: async () => {},
    child: async (env, cwd, onLine, timeoutFor) => {
      const result = await preflightChild(env, cwd, onLine, timeoutFor, timed.runner);
      results.push(result);
      return result;
    },
  };
  return { deps, results, ...timed };
}

/** Wait (on the real clock) for the injected runner to be spawned. */
async function spawnedWithin(ready: Promise<void>, ms = 10_000): Promise<void> {
  const timedOut = realSleep(ms).then(() => { throw new Error("the preflight never spawned its child through the injected runner"); });
  await Promise.race([ready, timedOut]);
}

const PROGRESS = '{"progress":"pull"}';

describe("the preflight's stage clocks (issue #52)", () => {
  afterEach(() => { vi.useRealTimers(); });

  test("preflightChild re-arms the pull clock on each progress line", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const steady = [{ at: 1_000, line: '{"done":"runtime"}' }];
    for (let at = 31_000; at <= 181_000; at += 30_000) steady.push({ at, line: PROGRESS });
    steady.push({ at: 190_000, line: '{"done":"pull"}' }, { at: 195_000, line: '{"done":"start"}' });
    const ok = onFakeClock(steady, 196_000);
    const service = preflightTestcontainers("/p", "x.store.test.ts", "", ok.deps);
    service.catch(() => {});
    await spawnedWithin(ok.ready);
    await vi.advanceTimersByTimeAsync(200_000);
    await expect(service).resolves.toMatchObject({ env: {} });
    expect(ok.results).toHaveLength(1);
    expect(ok.results[0]!.timedOut).toBe(false);

    // No progress after the runtime: the pull's stall clock runs out at 60 s.
    const stalled = onFakeClock([{ at: 1_000, line: '{"done":"runtime"}' }]);
    const started = Date.now();
    const refused = preflightTestcontainers("/p", "x.store.test.ts", "", stalled.deps);
    refused.catch(() => {});
    await spawnedWithin(stalled.ready);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(refused).rejects.toThrow(/did not finish in time/);
    expect(stalled.results[0]?.timedOut).toBe(true);
    expect(stalled.seen.killedAt! - started).toBeGreaterThanOrEqual(60_000);
    expect(stalled.seen.killedAt! - started).toBeLessThanOrEqual(62_000);
  });

  test("without a deadline a slow, steady pull is still bounded", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const forever = [{ at: 1_000, line: '{"done":"runtime"}' }];
    for (let at = 31_000; at <= 2_500_000; at += 30_000) forever.push({ at, line: PROGRESS });
    const slow = onFakeClock(forever);
    const started = Date.now();
    const refused = preflightTestcontainers("/p", "x.store.test.ts", "", { ...slow.deps, env: { PATH: "/usr/bin" } });
    refused.catch(() => {});
    await spawnedWithin(slow.ready);
    for (let i = 0; i < 70 && slow.seen.killedAt === undefined; i++) await vi.advanceTimersByTimeAsync(30_000);
    expect(slow.seen.killedAt).toBeDefined();
    const pullRan = slow.seen.killedAt! - started - 1_000;
    expect(pullRan).toBeGreaterThanOrEqual(1_800_000);
    expect(pullRan).toBeLessThanOrEqual(1_830_000);
    await expect(refused).rejects.toThrow(/did not finish in time/);
  });

  test("every stage clock fits the call's remaining budget", async () => {
    let now = 0;
    const seen: [number, number][] = [];
    const deps: PreflightDeps = {
      ...scriptedChild([], 0).deps,
      now: () => now,
      deadlineMs: 120_000,
      child: async (_env, _cwd, onLine, timeoutFor) => {
        seen.push([now, timeoutFor()]);
        for (const line of DONE) {
          now += 5_000;
          onLine(line);
          seen.push([now, timeoutFor()]);
        }
        return { status: 0, stdout: "", stderr: "", timedOut: false };
      },
    };
    await preflightTestcontainers("/p", "x.store.test.ts", "", deps);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    for (const [elapsed, budget] of seen) {
      expect(budget, `at ${elapsed} ms`).toBeGreaterThan(0);
      expect(budget, `at ${elapsed} ms`).toBeLessThanOrEqual(102_000 - elapsed);
    }
  });

  test("a stage whose minimum no longer fits is refused before it starts", async () => {
    let spawned = 0;
    const deps: PreflightDeps = {
      ...scriptedChild(DONE, 0).deps,
      now: () => 95_000,
      deadlineMs: 120_000,
      child: async () => { spawned++; return { status: 0, stdout: "", stderr: "", timedOut: false }; },
    };
    await expect(preflightTestcontainers("/p", "x.store.test.ts", "", deps)).rejects.toThrow(/call the gate again with a longer command timeout/);
    expect(spawned).toBe(0);
  });
});

// Final review of #52, major 1: a healthy engine that runs out of the call's
// time is the calling role's to retry with a longer timeout, never the user's.
describe("a stage cut short by the call's budget, not its own clock", () => {
  test("is refused as over budget, routed to the caller, not classified as the engine's failure", async () => {
    const budgets: number[] = [];
    const deps: PreflightDeps = {
      ...scriptedChild([], 0).deps,
      now: () => 80_000, // 22 s left of a 102 s budget: enough to start the runtime stage
      deadlineMs: 120_000,
      child: async (_env, _cwd, _onLine, timeoutFor) => {
        budgets.push(timeoutFor());
        return { status: null, stdout: "", stderr: "", timedOut: true };
      },
    };
    let error: unknown;
    try {
      await preflightTestcontainers("/p", "x.store.test.ts", "", deps);
    } catch (caught) {
      error = caught;
    }
    expect(budgets).toEqual([22_000]);
    expect((error as Error).message).toMatch(/call the gate again with a longer command timeout/);
    expect((error as Error).message).not.toMatch(/container engine|restart/);
    expect(error).not.toMatchObject({ route: "user" });
  });

  test("a stage that runs out of its own clock, with time to spare, is still the engine's", async () => {
    const deps: PreflightDeps = {
      ...scriptedChild([], 0).deps,
      now: () => 0,
      deadlineMs: 600_000,
      child: async (_env, _cwd, _onLine, timeoutFor) => {
        expect(timeoutFor()).toBe(60_000);
        return { status: null, stdout: "", stderr: "", timedOut: true };
      },
    };
    await expect(preflightTestcontainers("/p", "x.store.test.ts", "", deps)).rejects.toMatchObject({ route: "user" });
  });
});

describe("the preflight's remedies are the user's, in product terms (issue #52)", () => {
  test("a credential-helper failure during Testcontainers' own pull is still classified", async () => {
    const { deps } = scriptedChild(['{"done":"runtime"}', JSON.stringify({
      failed: "pull",
      error: 'error getting credentials - err: exec: "docker-credential-osxkeychain": executable file not found in $PATH, out: ``',
    })], 1);
    mkdirSync(join(deps.home, ".docker"));
    writeFileSync(join(deps.home, ".docker", "config.json"), JSON.stringify({ credsStore: "osxkeychain" }));
    let error: unknown;
    try {
      await preflightTestcontainers("/p", "x.store.test.ts", "", { ...deps, env: { PATH: "/usr/bin" } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/registry login helper that isn't installed/);
    expect(message).not.toContain("docker pull");
    expect(commandsIn(`the user: ${message}`)).toEqual([]);
    expect(error).toMatchObject({ route: "user" });
  });

  test("every remedy is in product terms with no docker command", () => {
    const cases: readonly [string, "runtime" | "pull" | "start", boolean][] = [
      ["Error from Docker credential provider: Error: spawn docker-credential-desktop ENOENT", "pull", false],
      ["Error: Could not find a working container runtime strategy", "runtime", false],
      ["connect ECONNREFUSED /var/run/docker.sock", "runtime", false],
      ["Error: Failed to connect to Reaper", "start", false],
      ["toomanyrequests: You have reached your pull rate limit", "pull", false],
      ["", "pull", true],
      ["", "start", true],
      ["Error: (HTTP code 409) conflict", "start", false],
    ];
    const kinds = new Set<InfrastructureKind>();
    for (const [text, stage, timedOut] of cases) {
      const found = classifyPreflightFailure(text, stage, timedOut, CONTEXT);
      kinds.add(found.kind);
      expect(commandsIn(`the user: ${found.remedy}`), found.kind).toEqual([]);
      expect(found.remedy, found.kind).not.toMatch(/\bdocker\s/i);
      expect(found.remedy, found.kind).not.toMatch(/DOCKER_HOST|TESTCONTAINERS_|\.testcontainers\.properties/);
    }
    expect([...kinds].sort()).toEqual(["credential-helper", "no-runtime", "other", "pull", "reaper", "socket", "timeout"]);
  });
});

describe("one preflight per distinct Testcontainers resolution", () => {
  const files = ["contexts/a/src/adapters/out/drizzle/x.store.test.ts", "contexts/a/src/adapters/out/drizzle/y.store.test.ts",
    "contexts/b/src/adapters/out/drizzle/z.store.test.ts", "contexts/c/src/adapters/out/drizzle/w.store.test.ts",
    "contexts/d/src/adapters/out/drizzle/v.store.test.ts"];
  const resolved: Record<string, string | undefined> = {
    [files[0]!]: "/root-nm/tc.js", [files[1]!]: "/root-nm/tc.js", [files[2]!]: "/root-nm/tc.js",
    [files[3]!]: "/c-nm/tc.js", [files[4]!]: undefined,
  };

  test("groups store tests by the module their directory resolves; an unresolvable one is its own", () => {
    expect(preflightTargets(files, (file) => resolved[file])).toEqual([files[0], files[3], files[4]]);
  });

  test("runs each in order and stops at the first refusal", async () => {
    const ran: string[] = [];
    const all = await preflightAllStoreTests("/p", files, "", { set: {}, unset: [] },
      async (file) => { ran.push(file); return { description: "ok", env: {}, release: () => {} }; }, (file) => resolved[file]);
    expect(ran).toEqual([files[0], files[3], files[4]]);
    expect(all.description).toBe("ok");
    const refused: string[] = [];
    await expect(preflightAllStoreTests("/p", files, "", { set: {}, unset: [] },
      async (file) => { refused.push(file); if (file === files[3]) throw new Error("refused for c"); return { description: "ok", env: {}, release: () => {} }; },
      (file) => resolved[file])).rejects.toThrow("refused for c");
    expect(refused).toEqual([files[0], files[3]]);
  });
});

// --- the policy decision ------------------------------------------------------

const STORE = "contexts/pm/src/adapters/out/drizzle/projects/create-project.store.test.ts";
const up = () => ({ available: true as const, endpoint: "unix:///run/docker.sock" });
const service = (description: string, released: string[], env: Record<string, string> = {}): PreparedTestService =>
  ({ description, env, release: () => void released.push(description) });

describe("the decision: the preflight runs before anything else at green, and only with tests that need it", () => {
  const SMOKE = "apps/web/src/server/composition-root.test.ts";

  test("green with store tests: the preflight on the probed endpoint, over the store and persisting smoke tests", async () => {
    const order: string[] = [];
    const released: string[] = [];
    const decision = storeTestPhaseDecision({
      phase: "green", storeTests: [STORE], probe: up, persists: true, smokeTests: [SMOKE],
      preflight: async (endpoint, _env, files) => { order.push(`preflight ${endpoint} ${files.join(",")}`); return service("preflight", released); },
      infrastructureFailure: () => () => undefined,
    });
    if (decision.action !== "run") throw new Error("expected run");
    expect(order).toEqual([]);
    const started = await decision.prepare!({ set: {}, unset: [] });
    expect(order).toEqual([`preflight unix:///run/docker.sock ${STORE},${SMOKE}`]);
    expect(started.env).toEqual({});
    started.release();
    expect(released).toEqual(["preflight"]);
    expect(decision.infrastructureFailure).toBeTypeOf("function");
  });

  test("the preflight gets the run's environment change, as the test process will see it", async () => {
    const seen: unknown[] = [];
    const decision = storeTestPhaseDecision({
      phase: "green", storeTests: [STORE], probe: up, persists: true,
      preflight: async (_endpoint, env) => { seen.push(env); return service("preflight", []); },
    });
    if (decision.action !== "run") throw new Error("expected run");
    await decision.prepare!({ set: { A: "1" }, unset: ["B"] });
    expect(seen).toEqual([{ set: { A: "1" }, unset: ["B"] }]);
  });

  test("a failed preflight refuses through withPreparedServices, routed to the user", async () => {
    const decision = storeTestPhaseDecision({
      phase: "green", storeTests: [STORE], probe: up, persists: true,
      preflight: async () => { throw userRoutedError(preflightRefusal(recogniseInfrastructure("spawn docker-credential-desktop ENOENT", CONTEXT)!, POSTGRES_IMAGE)); },
    });
    const run = combineDecisions("green", [{ name: "store-tests-need-a-container-runtime", decision }]);
    let ran = false;
    const prepared = await withPreparedServices(run, async () => { ran = true; });
    expect(prepared.ok).toBe(false);
    expect(ran).toBe(false);
    if (!prepared.ok) {
      expect(prepared.reason).toContain("docker-credential-desktop is not installed");
      expect(prepared.route).toBe("user");
    }
  });

  test("red, and a tree with neither store nor persisting smoke tests, never preflight and carry no classifier", () => {
    let preflights = 0;
    const preflight = async () => { preflights++; return service("preflight", []); };
    const red = storeTestPhaseDecision({ phase: "red", storeTests: [STORE], probe: up, persists: true, preflight, infrastructureFailure: () => () => "x" });
    expect(red.action).toBe("skip");
    const noTests = storeTestPhaseDecision({ phase: "green", storeTests: [], probe: up, persists: true, preflight, infrastructureFailure: () => () => "x" });
    // A persisting tree never passes an inherited DATABASE_URL on (ADR 2026-072).
    expect(noTests).toEqual({ action: "run", unsetEnv: ["BOUNDED_STORE_TESTS_SKIP", "BOUNDED_STORE_TESTS_PHASE", "DATABASE_URL"] });
    expect(preflights).toBe(0);
  });

  test("a persisting tree whose smoke tests have no runtime is refused at green, routed to the user", () => {
    const down = () => ({ available: false as const, reason: "no container runtime found" });
    const decision = storeTestPhaseDecision({ phase: "green", storeTests: [], probe: down, persists: true, smokeTests: [SMOKE] });
    expect(decision).toMatchObject({ action: "refuse", route: "user" });
    expect((decision as { reason: string }).reason).toMatch(/smoke tests each start a throwaway migrated database.*start it/);
  });
});

describe("storeTestInfrastructureFailure: the defence in depth", () => {
  const classify = storeTestInfrastructureFailure([STORE], CONTEXT);

  test("claims a store test, or a failure no file claims, that failed because of the machine", () => {
    expect(classify({ name: "DrizzleCreateProjectStore > (unnamed)", file: STORE, message: "error: Error from Docker credential provider: Error: spawn docker-credential-desktop ENOENT" }))
      .toBe("DrizzleCreateProjectStore > (unnamed): error: Error from Docker credential provider: Error: spawn docker-credential-desktop ENOENT. " +
        `Remedy: ${HELPER} (~/.docker/config.json names credsStore 'desktop', and docker-credential-desktop is not installed)`);
    expect(classify({ name: "unhandled error", message: "Could not find a working container runtime strategy" })).toMatch(/the container engine isn't running: start it/);
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
    expect(causes.some((cause) => cause?.includes("docker-credential-desktop is not installed"))).toBe(true);
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

describe("the green gate (with fakes): the machine's failures go to the user, never a role", () => {
  test("a failed preflight refuses before any test runs, with the cause and the remedy", async () => {
    const dir = builtWithStandingRed();
    const marker = join(dir, ".suite-ran");
    const decision = storeTestPhaseDecision({
      phase: "green", storeTests: [STORE], probe: up,
      preflight: async () => { throw userRoutedError(preflightRefusal(recogniseInfrastructure("spawn docker-credential-desktop ENOENT", CONTEXT)!, POSTGRES_IMAGE)); },
      infrastructureFailure: () => storeTestInfrastructureFailure([STORE], CONTEXT),
    });
    const policy = combineDecisions("green", [{ name: "store-tests-need-a-container-runtime", decision }]);
    const env = { ...cannedGateEnv(dir, PASSING), BOUNDED_GATE_TEST_CMD: "sh", BOUNDED_GATE_TEST_ARGS: JSON.stringify(["-c", `touch '${marker}'; exit 1`]) };
    const r = await withEnv(env, () => runGreenGate(dir, { policy }));
    expect(r).toMatchObject({ code: 1, verdict: "block", detail: { reason: "test-policy", route: "user" } });
    expect(r.lines.at(-1)).toBe("green-gate: route → user");
    expect(r.lines.join("\n")).toContain("~/.docker/config.json names credsStore 'desktop', and docker-credential-desktop is not installed)");
    expect(r.lines.join("\n")).not.toContain("route → builder");
    expect(existsSync(marker)).toBe(false);
  }, 120_000);

  test("a store test that still fails because of the machine routes to the user with the cause, not the builder", async () => {
    const dir = builtWithStandingRed();
    const decision = storeTestPhaseDecision({
      phase: "green", storeTests: [STORE], probe: up,
      preflight: async () => service("preflight", []),
      infrastructureFailure: () => storeTestInfrastructureFailure([STORE], CONTEXT),
    });
    const policy = combineDecisions("green", [{ name: "store-tests-need-a-container-runtime", decision }]);
    const cases: CannedCase[] = [...PASSING, {
      name: "DrizzleCreateProjectStore > (unnamed)", status: "failed", file: STORE,
      message: "error: Failed to pull image \"postgres:17.6\": getaddrinfo ENOTFOUND registry-1.docker.io",
    }];
    const r = await withEnv(cannedGateEnv(dir, cases), () => runGreenGate(dir, { policy }));
    expect(r).toMatchObject({ code: 1, verdict: "block", detail: { reason: "infrastructure", route: "user" } });
    expect(r.lines.at(-1)).toBe("green-gate: route → user");
    expect(r.lines.join("\n")).toContain("the container engine can't fetch images");

    // The same run with an ordinary assertion failure is still the builder's, with no note.
    const ordinary = await withEnv(cannedGateEnv(dir, [...PASSING, { name: "DrizzleCreateProjectStore > saves", status: "failed", file: STORE, message: "error: expected 1 to be 2" }]),
      () => runGreenGate(dir, { policy }));
    expect(ordinary.lines).toContain("green-gate: route → builder");
  }, 120_000);

  test("a mix never hides the code's failure: the route stays the builder's, which is named, with the machine's cause as a note", async () => {
    const dir = builtWithStandingRed();
    const decision = storeTestPhaseDecision({
      phase: "green", storeTests: [STORE], probe: up,
      preflight: async () => service("preflight", []),
      infrastructureFailure: () => storeTestInfrastructureFailure([STORE], CONTEXT),
    });
    const policy = combineDecisions("green", [{ name: "store-tests-need-a-container-runtime", decision }]);
    const cases: CannedCase[] = [...PASSING,
      { name: "DrizzleCreateProjectStore > (unnamed)", status: "failed", file: STORE, message: "error: Error from Docker credential provider: Error: spawn docker-credential-desktop ENOENT" },
      { name: "CreateNoteHandler > rejects a blank title", status: "failed", message: "error: expected false to be true" },
    ];
    const r = await withEnv(cannedGateEnv(dir, cases), () => runGreenGate(dir, { policy }));
    expect(r).toMatchObject({ code: 1, verdict: "block", detail: { reason: "failures", route: "builder" } });
    expect(r.lines).toContain("  failed: CreateNoteHandler > rejects a blank title");
    expect(r.lines.at(-1)).toBe("green-gate: route → builder");
    const note = r.lines.findIndex((line) => line.startsWith("green-gate: note — one failure looks like the machine's"));
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(r.lines.length - 1);
    expect(r.lines.join("\n")).toContain("suspected infrastructure: DrizzleCreateProjectStore > (unnamed)");
    expect(r.lines.join("\n")).toContain("docker-credential-desktop is not installed");
    expect((r.detail as { suspectedInfrastructure?: unknown }).suspectedInfrastructure).toHaveLength(1);
  }, 120_000);
});
