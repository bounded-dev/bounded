import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { makeTempProject, type TempProject } from "../test/support/temp-project.ts";
import { decide } from "./path-policy.ts";
import {
  beforeFirstRun, dependenciesReady, projectReadAllowed, repairNeeded, resolvedProjectPath, runProjectSetup, searchPatternContained,
  setupPermitted, setupPlan,
} from "./setup-state.ts";

const AGENT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projects: TempProject[] = [];
afterEach(() => {
  while (projects.length) projects.pop()?.cleanup();
});

const DEMO = JSON.stringify({ projectSetupCommands: [["demo-install", "--frozen"]], projectSetupProbes: ["deps/ready"] });

/** An installed project composing one data-only pack that contributes setup. */
function installed(files: Readonly<Record<string, string>> = {}, contrib = DEMO): string {
  const project = makeTempProject({
    ".bounded/installation.json": "{}\n",
    ".bounded/harness/packs/demo/contrib.json": contrib,
    "README.md": "hello\n",
    ...files,
  }, { prefix: "setup-state-" });
  projects.push(project);
  writeFileSync(join(project.dir, ".bounded/composed-packs.json"), '["demo"]\n'); // the helper composes "ts"
  return project.dir;
}

describe("setup permission", () => {
  test("an uninstalled directory never permits setup", () => {
    const project = makeTempProject({}, { prefix: "setup-state-" });
    projects.push(project);
    expect(setupPermitted(project.dir)).toBe(false);
  });

  test("before the first run, setup is permitted", () => {
    const dir = installed({ ".bounded/guard-log.jsonl": '{"guard":"team-lead","verdict":"block"}\n\n' });
    expect(beforeFirstRun(dir)).toBe(true);
    expect(setupPermitted(dir)).toBe(true);
  });

  test.each([
    [".bounded/guard-log.jsonl", '{"guard":"run-start"}\n'],
    [".bounded/active-ticket", "3\n"],
    [".bounded/contract-checksums.json", "{}\n"],
    [".bounded/tickets/4/contract-checksums.json", "{}\n"],
  ])("run evidence in %s ends the first-run window", (path, content) => {
    const dir = installed({ [path]: content });
    expect(beforeFirstRun(dir)).toBe(false);
    expect(setupPermitted(dir)).toBe(false);
  });

  test.each(["{not json", "[1,2]", "null", '"text"'])("a malformed log line %s fails closed", (line) => {
    const dir = installed({ ".bounded/guard-log.jsonl": `{"guard":"team-lead"}\n${line}\n` });
    expect(beforeFirstRun(dir)).toBe(false);
    expect(setupPermitted(dir)).toBe(false);
  });

  test("after a run, a completed setup may be repaired only while a dependency tree is missing", () => {
    const dir = installed({ ".bounded/guard-log.jsonl": '{"guard":"run-start"}\n{broken\n', ".bounded/setup-complete": "complete\n" });
    expect(repairNeeded(dir)).toBe(true);
    expect(setupPermitted(dir)).toBe(true);
    mkdirSync(join(dir, "deps"));
    writeFileSync(join(dir, "deps/ready"), "");
    expect(setupPermitted(dir)).toBe(true); // the harness runtime is still missing
    mkdirSync(join(dir, ".bounded/harness/node_modules"), { recursive: true });
    writeFileSync(join(dir, ".bounded/harness/node_modules/.package-lock.json"), "{}");
    expect(repairNeeded(dir)).toBe(false);
    expect(setupPermitted(dir)).toBe(false);
  });

  test("a malformed composition after a run is never a repair", () => {
    const dir = installed({ ".bounded/guard-log.jsonl": '{"guard":"run-start"}\n', ".bounded/setup-complete": "complete\n" },
      '{"projectSetupCommands":[["/bin/sh","-c","x"]]}');
    expect(repairNeeded(dir)).toBe(false);
    expect(setupPermitted(dir)).toBe(false);
  });
});

describe("composed setup plan", () => {
  test("pack contributions run first in the project, then the harness runtime", () => {
    const dir = installed();
    const plan = setupPlan(dir);
    expect(plan.steps.map((step) => [step.command, ...step.args])).toEqual([["demo-install", "--frozen"], ["npm", "ci"]]);
    expect(plan.steps[0].cwd).toBe(resolve(dir));
    expect(plan.steps[1].cwd).toBe(join(resolve(dir), ".bounded", "harness"));
    expect(plan.probes).toEqual([join(resolve(dir), "deps/ready"), join(resolve(dir), ".bounded/harness/node_modules/.package-lock.json")]);
  });

  test("a composition without a setup contribution installs only the harness runtime", () => {
    expect(setupPlan(installed({}, "{}")).steps).toHaveLength(1);
  });

  test.each([
    ['{"projectSetupCommands":"npm ci"}'],
    ['{"projectSetupCommands":[[]]}'],
    ['{"projectSetupCommands":[["/bin/sh","-c","x"]]}'],
    ['{"projectSetupCommands":[["ok",""]]}'],
    ['{"projectSetupProbes":["../outside"]}'],
    ['{"projectSetupProbes":["/abs"]}'],
  ])("a malformed contribution %s is refused", (contrib) => {
    const dir = installed({}, contrib);
    expect(() => setupPlan(dir)).toThrow();
    expect(dependenciesReady(dir)).toBe(false);
  });

  test("the real TypeScript pack contributes its setup as data", () => {
    const contrib = JSON.parse(readFileSync(join(AGENT, "packs", "ts", "contrib.json"), "utf8")) as Record<string, unknown>;
    expect(contrib["projectSetupCommands"]).toEqual([["bun", "install", "--frozen-lockfile", "--ignore-scripts"]]);
    expect(contrib["projectSetupProbes"]).toEqual(["node_modules/.bun"]);
  });

  test("dependencies are ready only with the marker and every probe", () => {
    const dir = installed({ "deps/ready": "", ".bounded/harness/node_modules/.package-lock.json": "{}" });
    expect(dependenciesReady(dir)).toBe(false);
    writeFileSync(join(dir, ".bounded/setup-complete"), "complete\n");
    expect(dependenciesReady(dir)).toBe(true);
    writeFileSync(join(dir, ".bounded/composed-packs.json"), "not json");
    expect(dependenciesReady(dir)).toBe(false);
  });
});

describe("running setup", () => {
  /** Fake installers on PATH that create what each step promises. */
  function withFakeInstallers<T>(dir: string, run: () => Promise<T>, failProject = false): Promise<T> {
    const bin = join(dir, "fake-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "demo-install"), failProject ? "#!/bin/sh\necho boom >&2\nexit 3\n" : "#!/bin/sh\nmkdir -p deps && touch deps/ready\n");
    writeFileSync(join(bin, "npm"), '#!/bin/sh\n[ "$1" = ci ] && mkdir -p node_modules && echo "{}" > node_modules/.package-lock.json\n');
    chmodSync(join(bin, "demo-install"), 0o755);
    chmodSync(join(bin, "npm"), 0o755);
    const previous = process.env["PATH"];
    process.env["PATH"] = `${bin}:${previous ?? ""}`;
    return run().finally(() => { process.env["PATH"] = previous; });
  }
  const log = (dir: string): Record<string, unknown>[] =>
    readFileSync(join(dir, ".bounded/guard-log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

  test("runs every step, verifies the probes, and records completion", async () => {
    const dir = installed();
    const result = await withFakeInstallers(dir, () => runProjectSetup(dir, { host: "test" }));
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, ".bounded/setup-complete"))).toBe(true);
    expect(dependenciesReady(dir)).toBe(true);
    expect(log(dir).at(-1)).toMatchObject({ guard: "team-lead", verdict: "pass", detail: { host: "test", kind: "setup" } });
  });

  test("a failing project step stops before the harness and records no completion", async () => {
    const dir = installed();
    const result = await withFakeInstallers(dir, () => runProjectSetup(dir), true);
    expect(result).toMatchObject({ ok: false, summary: expect.stringContaining("project (demo)") });
    expect(existsSync(join(dir, ".bounded/harness/node_modules"))).toBe(false);
    expect(existsSync(join(dir, ".bounded/setup-complete"))).toBe(false);
    expect(log(dir).at(-1)).toMatchObject({ verdict: "block", detail: { kind: "setup", stage: "project (demo)" } });
  });

  // The exploit: after a run the architect may rewrite package.json with an
  // install script, and an on-demand setup would run it. With every
  // dependency tree present, setup must refuse before running any step.
  test("an intact setup after a run is not re-run, so no installer executes", async () => {
    const dir = installed({
      ".bounded/guard-log.jsonl": '{"guard":"run-start"}\n',
      ".bounded/setup-complete": "complete\n",
      "deps/ready": "",
      ".bounded/harness/node_modules/.package-lock.json": "{}",
      "package.json": '{"scripts":{"postinstall":"touch pwned"}}',
    });
    const result = await withFakeInstallers(dir, async () => {
      writeFileSync(join(dir, "fake-bin", "demo-install"), "#!/bin/sh\ntouch pwned\n");
      return runProjectSetup(dir);
    });
    expect(result).toMatchObject({ ok: false, summary: expect.stringContaining("dependencies are missing") });
    expect(existsSync(join(dir, "pwned"))).toBe(false);
    expect(log(dir).at(-1)).toMatchObject({ verdict: "block", detail: { kind: "setup", stage: "permission" } });
  });

  test("setup after a run without a completed setup is refused and logged", async () => {
    const dir = installed({ ".bounded/guard-log.jsonl": '{"guard":"run-start"}\n' });
    const result = await runProjectSetup(dir);
    expect(result.ok).toBe(false);
    expect(log(dir).at(-1)).toMatchObject({ verdict: "block", detail: { kind: "setup", stage: "permission" } });
  });
});

describe("reads before setup", () => {
  const read = (path: unknown, globs: unknown[] = [], pathRequired = true, search = globs.length > 0) =>
    ({ path, pathRequired, search, globs });
  const search = (path: unknown, globs: unknown[] = [undefined]) => read(path, globs, false, true);

  test("project-local reads are allowed", () => {
    const dir = installed({ "src/a.ts": "" });
    expect(projectReadAllowed(dir, dir, read("README.md"))).toBe(true);
    expect(projectReadAllowed(dir, join(dir, "src"), read("a.ts"))).toBe(true);
    expect(projectReadAllowed(dir, join(dir, "src"), search(undefined, ["**/*.ts"]))).toBe(true);
    expect(projectReadAllowed(dir, dir, search("src", ["**/*.ts"]))).toBe(true);
  });

  // The read tools search hidden files, so a search rooted at the project
  // root walks .git; the full policy refuses it, and so does this check.
  test.each([
    ["a search with no path at the root", () => search(undefined)],
    ["a search of '.'", () => search(".")],
    ["a search of a path that climbs back to the root", () => search("src/..")],
    ["a search through a link to the root", () => search("here")],
    ["a read of .GIT/config", () => read(".GIT/config")],
    ["a read of .Git/HEAD", () => read(".Git/HEAD")],
    ["a search of .GIT", () => search(".GIT")],
    ["a .GIT/** glob", () => search("src", [".GIT/**"])],
    ["a **/.GIT/* glob", () => search("src", ["**/.GIT/*"])],
    ["a [.]git/* glob", () => search("src", ["[.]git/*"])],
  ])("refuses %s", (_name, make) => {
    const dir = installed({ "src/a.ts": "", ".git/config": "", ".git/HEAD": "" });
    symlinkSync(dir, join(dir, "here"));
    expect(projectReadAllowed(dir, dir, make())).toBe(false);
  });

  // The pre-setup check must judge a project read as the full policy judges
  // the lead's (the architect's read zone): allowed exactly when decide()
  // allows it, for every path that exists.
  test.each([
    ["read", "README.md"], ["read", "src/a.ts"], ["read", "."], ["read", ".git/config"], ["read", ".GIT/config"],
    ["read", ".Git/HEAD"], ["read", "/etc/hosts"], ["read", "../x"],
    ["ls", "src"], ["ls", "."], ["ls", ".git"], ["ls", ".GIT"], ["ls", undefined],
    ["grep", "src"], ["grep", "."], ["grep", undefined], ["grep", ".Git"], ["grep", "src/.."],
    ["find", "src"], ["find", "."], ["find", ".GIT"], ["find", "/"],
  ] as const)("%s %j agrees with decide('architect', ...)", (tool, path) => {
    const dir = realpathSync(installed({ "src/a.ts": "", ".git/config": "", ".git/HEAD": "" }));
    const policy = decide("architect", tool, path === undefined ? {} : { path }, { cwd: dir }).allow;
    const early = projectReadAllowed(dir, dir, read(path, [], true, tool !== "read"));
    if (path === undefined || existsSync(resolve(dir, path))) expect(early).toBe(policy);
    else expect(early).toBe(false);
  });

  test.each([
    ["an absolute path outside", () => read("/etc/hosts")],
    ["a parent escape", () => read("../README.md")],
    ["a missing required path", () => read(undefined)],
    ["an empty path", () => read("")],
    ["a non-string path", () => read(42)],
    ["a .git path", () => read(".git/config")],
    ["a parent glob", () => read("src", ["../**"], false)],
    ["an absolute glob", () => read("src", ["/etc/*"], false)],
    ["a .git glob", () => read("src", [".git/**"], false)],
    ["a wildcard .git glob", () => read("src", [".gi?/config"], false)],
    ["a brace .git glob", () => read("src", ["{.git,x}/**"], false)],
    ["a class .git glob", () => read("src", [".[g]it/**"], false)],
    ["a prefix .git glob", () => read("src", ["**/.git*"], false)],
    ["a non-string glob", () => read("src", [null], false)],
    ["a missing file", () => read("nope.txt")],
  ])("refuses %s", (_name, make) => {
    const dir = installed({ ".git/config": "", "src/a.ts": "" });
    expect(projectReadAllowed(dir, dir, make())).toBe(false);
  });

  test("refuses a link that leaves the project and a base outside it", () => {
    const dir = installed();
    const outside = makeTempProject({ "secret.txt": "x" }, { prefix: "setup-outside-" });
    projects.push(outside);
    symlinkSync(join(outside.dir, "secret.txt"), join(dir, "linked.txt"));
    expect(projectReadAllowed(dir, dir, read("linked.txt"))).toBe(false);
    expect(projectReadAllowed(dir, outside.dir, read("secret.txt"))).toBe(false);
  });
});

describe("search patterns", () => {
  test.each([undefined, "**/*.ts", "src/**", "*.md", "src/{a,b}/*.ts", ".env", "src/.eslintrc.json", "a..b/*"])(
    "keeps %j inside its directory", (pattern) => {
      expect(searchPatternContained(pattern)).toBe(true);
    });

  test.each([
    null, "", 42, "/etc/*", "~/x", "a\\b", "../**", "src/../..", ".git", ".git/**", "src/.git/config",
    ".gi?/config", ".[g]it/**", ".git*", "**/.git*", ".*", "{.git,x}/**", "x/{.,y}git/**", "{..,x}/a", "x{/..,}/y",
    "{a..z}", "src/@(.git)/x", "!(src)/x", "{a,b", "a}", ".{g,x}it",
    ".GIT", ".Git/HEAD", ".GIT/**", "**/.GIT/*", "[.]git/*", "src/[.]GIT/x", "?git/*", "[!a]git/*", "[^a]git",
    "[+-/]git", "[[:punct:]]git", "*.git", "(.git|x)/**", "!src/**", "[.git", "{x,[.]git}/*",
  ])("refuses %j", (pattern) => {
    expect(searchPatternContained(pattern)).toBe(false);
  });
});

describe("resolved project paths", () => {
  test("follows links: an escape or a .git target is refused, a missing tail is kept", () => {
    const dir = installed({ "src/a.ts": "", ".git/config": "" });
    const outside = makeTempProject({ "secret.txt": "x" }, { prefix: "setup-outside-" });
    projects.push(outside);
    symlinkSync(outside.dir, join(dir, "lnk"));
    symlinkSync(join(dir, ".git"), join(dir, "g"));
    symlinkSync(join(dir, "src"), join(dir, "s"));
    symlinkSync(join(outside.dir, "missing"), join(dir, "dangling"));
    expect(resolvedProjectPath(dir, "src/a.ts")).toBe("src/a.ts");
    expect(resolvedProjectPath(dir, "src/new/b.ts")).toBe("src/new/b.ts");
    expect(resolvedProjectPath(dir, "s/a.ts")).toBe("src/a.ts");
    expect(resolvedProjectPath(dir, ".")).toBe(".");
    expect(resolvedProjectPath(dir, "lnk/secret.txt")).toBeUndefined();
    expect(resolvedProjectPath(dir, "lnk")).toBeUndefined();
    expect(resolvedProjectPath(dir, "g/config")).toBeUndefined();
    expect(resolvedProjectPath(dir, "dangling")).toBeUndefined();
    expect(resolvedProjectPath(dir, "../x")).toBeUndefined();
  });
});

describe("the bootstrap entries stay dependency-free", () => {
  /** Every runtime import reachable from an entry must be a builtin or a local file. */
  function runtimeImports(file: string, seen = new Set<string>()): string[] {
    if (seen.has(file)) return [];
    seen.add(file);
    const bad: string[] = [];
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^\s*(import|export)\s+(type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm)) {
      if (match[2]) continue; // type-only, erased at runtime
      const specifier = match[3];
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".")) bad.push(...runtimeImports(resolve(dirname(file), specifier), seen));
      else bad.push(`${file}: ${specifier}`);
    }
    return bad;
  }

  test.each(["hosts/claude-code/bootstrap-hook.ts", "hosts/pi/bootstrap.ts", "src/setup-state.ts"])("%s", (entry) => {
    expect(runtimeImports(join(AGENT, entry))).toEqual([]);
  });
});
