import { writeProjectPacks } from "../../../src/project-composition.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { barrelFor, checkSummaryLine, runDeliver, spawnRun, stripConformance } from "./deliver.ts";
import type { CommandOutcome, CommandRun } from "./deliver.ts";
import { readGuardLog } from "../../../src/guard-log.ts";
import type { PhaseDurations } from "../../../src/phase-durations.ts";

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const ERRORS_TS = `export class NotImplementedError extends Error {
  constructor(what: string) {
    super(\`NotImplemented: \${what}\`);
    this.name = "NotImplementedError";
  }
}

export function notImplemented(what: string): never {
  throw new NotImplementedError(what);
}
`;

const CONTRACT_TS = `export interface Order {
  readonly id: string;
}

export declare function placeOrder(id: string): Order;
`;

const IMPL_TS = `import type { Order } from "./orders.contract.js";
import type * as __Contract from "./orders.contract.js";

export type * from "./orders.contract.js";

export function placeOrder(id: string): Order {
  return { id };
}

// Compile-time conformance: every scaffoldable value export of the contract
// exists above, with the signature the contract declared.
const __conformance: typeof __Contract = { placeOrder };
void __conformance;
`;

const PACKAGE_JSON = `{
  "name": "fixture",
  "private": true,
  "type": "module",
  "scripts": {
    "check": "tsc --noEmit && vitest run",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
`;

const SURFACE_STUB = "// stub surface checker (the real one ships from the pack)\n";

/** A finished run's worth of guard events, as the gates would have appended
 *  them: design froze at +4m, red passed at +20m, green at +48m, with one
 *  bounce to the test-writer inside TEST. Timestamps are fixed so the block
 *  the timing step prints is exact rather than approximately right. */
const SEEDED_GUARD_LOG = [
  { ts: "2026-03-01T09:00:00.000Z", guard: "contract-purity", verdict: "pass", summary: "OK (1 file)" },
  { ts: "2026-03-01T09:04:00.000Z", guard: "checksum-gate", verdict: "pass", summary: "wrote manifest (1 contract file)" },
  {
    ts: "2026-03-01T09:12:00.000Z",
    guard: "red-gate",
    verdict: "block",
    summary: "2 wrong-reason failures (route: test-writer)",
    detail: { reason: "wrong-reason", route: "test-writer" },
  },
  { ts: "2026-03-01T09:20:00.000Z", guard: "red-gate", verdict: "pass", summary: "RED OK (5 NotImplemented failures, 0 passed)" },
  { ts: "2026-03-01T09:48:00.000Z", guard: "green-gate", verdict: "pass", summary: "GREEN (5/5 passed, typecheck clean)" },
]
  .map((e) => JSON.stringify(e))
  .join("\n") + "\n";

/** The same run, plus the refusals r14 spent its afternoon on. */
const FRICTION_GUARD_LOG = [
  { ts: "2026-03-01T09:00:00.000Z", guard: "contract-purity", verdict: "pass", summary: "OK (1 file)" },
  { ts: "2026-03-01T09:01:00.000Z", guard: "path-gate", verdict: "block", summary: "architect may not write src/x.ts" },
  { ts: "2026-03-01T09:02:00.000Z", guard: "phase-gate", verdict: "block", summary: "test-writer may not spawn yet" },
  { ts: "2026-03-01T09:04:00.000Z", guard: "checksum-gate", verdict: "pass", summary: "wrote manifest (1 contract file)" },
  { ts: "2026-03-01T09:20:00.000Z", guard: "red-gate", verdict: "pass", summary: "RED OK (5 NotImplemented failures, 0 passed)" },
  { ts: "2026-03-01T09:30:00.000Z", guard: "path-gate", verdict: "block", summary: "builder may not write tests/y.test.ts" },
  {
    ts: "2026-03-01T09:40:00.000Z",
    guard: "green-gate",
    verdict: "block",
    summary: "1 failing test (route: builder)",
    detail: { route: "builder" },
  },
  { ts: "2026-03-01T09:48:00.000Z", guard: "green-gate", verdict: "pass", summary: "GREEN (5/5 passed, typecheck clean)" },
]
  .map((e) => JSON.stringify(e))
  .join("\n") + "\n";

/** A minimal finished-run-shaped project: package.json + one contract pair. */
function proj(extra: Record<string, string> = {}, base: Record<string, string> | null = null): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-deliver-"));
  writeProjectPacks(dir, ["ts"]);
  tmpDirs.push(dir);
  const files: Record<string, string> = base ?? {
    "package.json": PACKAGE_JSON,
    ".gitignore": "node_modules/\n",
    "src/orders/orders.contract.ts": CONTRACT_TS,
    "src/orders/orders.ts": IMPL_TS,
    "src/shared/errors.ts": ERRORS_TS,
  };
  for (const [rel, content] of Object.entries({ ".bounded/composed-packs.json": JSON.stringify(["ts"]), ...files, ...extra })) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

/** Every test injects the surface-checker source: the real pack file is a
 *  concurrent workstream and may not exist yet. */
function surfaceStub(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-deliver-stub-"));
  writeProjectPacks(dir, ["ts"]);
  tmpDirs.push(dir);
  const path = join(dir, "surface-check.ts");
  writeFileSync(path, SURFACE_STUB);
  return path;
}

/** A passing `npm run check`, shaped like the real thing. */
const CHECK_OK: CommandOutcome = {
  code: 0,
  stdout: `
> fixture@ check
> tsc --noEmit && vitest run && npm run check:surface

surface-check: OK (1 contract pair)
 Test Files  1 passed (1)
      Tests  5 passed (5)
`,
  stderr: "",
};

interface NpmCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Did the barrel exist when this call was made? (Step ordering, observed.) */
  readonly barrelPresent: boolean;
}

interface FakeNpmOptions {
  /** Outcome of `npm install …` (default: success). */
  readonly install?: CommandOutcome;
  /** Should a "successful" install actually create node_modules/ts-morph? */
  readonly materialize?: boolean;
  /** Outcome of `npm run check` (default: {@link CHECK_OK}). */
  readonly check?: CommandOutcome;
}

/** npm, faked at the seam deliver spawns through: records every invocation and
 *  materializes node_modules/ts-morph the way a real install would. The real
 *  thing is covered once, offline-skippable, at the bottom of this file. */
function fakeNpm(options: FakeNpmOptions = {}): { calls: NpmCall[]; run: CommandRun } {
  const calls: NpmCall[] = [];
  const run: CommandRun = (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd, barrelPresent: existsSync(join(cwd, "src/index.ts")) });
    if (args[0] === "install") {
      const outcome = options.install ?? { code: 0, stdout: "added 3 packages\n", stderr: "" };
      if (outcome.code === 0 && (options.materialize ?? true)) {
        // Materialize whatever was asked for, the way a real install would —
        // "name@1.2.3" and "@scope/name@1.2.3" both resolve to their package dir.
        const spec = args[args.length - 1] ?? "ts-morph";
        const name = spec.startsWith("@")
          ? spec.slice(0, spec.indexOf("@", 1))
          : spec.split("@")[0] ?? spec;
        const pkgDir = join(cwd, "node_modules", ...name.split("/"));
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name }) + "\n");
      }
      return outcome;
    }
    return options.check ?? CHECK_OK;
  };
  return { calls, run };
}

function deliver(cwd: string, options: FakeNpmOptions = {}) {
  return runDeliver(cwd, { surfaceCheckSource: surfaceStub(), run: fakeNpm(options).run });
}

describe("stripConformance (pure)", () => {
  test("removes the blob, its comment, and the __Contract import — nothing else", () => {
    const out = stripConformance(IMPL_TS, "orders.ts");
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/__conformance|__Contract|Compile-time conformance/);
    expect(out).toContain('export type * from "./orders.contract.js";');
    expect(out).toContain('import type { Order } from "./orders.contract.js";');
    expect(out).toContain("export function placeOrder");
    expect(out?.endsWith("\n")).toBe(true);
    expect(out).not.toMatch(/\n{3,}/);
  });

  test("a file with nothing to strip returns null", () => {
    expect(stripConformance('export type * from "./x.contract.js";\nexport const a = 1;\n', "x.ts")).toBeNull();
  });
});

describe("barrelFor (pure)", () => {
  test("one line per implementation module, src-relative, .js specifiers", () => {
    const out = barrelFor(["shared/money.ts", "subscription-billing/subscription-billing.ts"]);
    expect(out).toContain('export * from "./shared/money.js";');
    expect(out).toContain('export * from "./subscription-billing/subscription-billing.js";');
    expect(out.endsWith("\n")).toBe(true);
  });

  // A NodeNext specifier names the EMITTED file, and TypeScript emits
  // `badge.js` from `badge.tsx` exactly as it does from `badge.ts`. A barrel
  // line saying `./ui/badge.tsx` resolves nowhere at runtime.
  test("a .tsx module is still spelled .js in the specifier", () => {
    expect(barrelFor(["ui/badge.tsx"])).toContain('export * from "./ui/badge.js";');
  });
});

describe("runDeliver", () => {
  test("full pass on a clean project: all steps fire, exit 0, summary line", () => {
    const dir = proj();
    const r = deliver(dir);
    expect(r.code).toBe(0);
    expect(r.lines.at(-1)).toMatch(/^deliver: OK — \d+ steps applied$/);

    // 1. dead scaffolding gone (nothing imports it), shared/ dir cleaned up
    expect(existsSync(join(dir, "src/shared/errors.ts"))).toBe(false);
    expect(existsSync(join(dir, "src/shared"))).toBe(false);
    // 2. conformance blob stripped, load-bearing re-export kept
    const impl = readFileSync(join(dir, "src/orders/orders.ts"), "utf8");
    expect(impl).not.toContain("__conformance");
    expect(impl).toContain('export type * from "./orders.contract.js";');
    // 3. barrel
    expect(readFileSync(join(dir, "src/index.ts"), "utf8")).toContain('export * from "./orders/orders.js";');
    // 4. surface check shipped and wired
    expect(readFileSync(join(dir, "scripts/surface-check.ts"), "utf8")).toBe(SURFACE_STUB);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.scripts["check:surface"]).toBe("node --experimental-strip-types scripts/surface-check.ts");
    expect(pkg.scripts.check).toContain("npm run check:surface");
    expect(pkg.devDependencies["ts-morph"]).toMatch(/^\d+\.\d+\.\d+$/);
    // 5. .bounded/ ignored
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toMatch(/^\.bounded\/$/m);
    // 6. README
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain("## Contracts");
    expect(readme).not.toMatch(/TN-\d+|harness|red-phase|scaffold/i);

    // each step logged a guard event
    const events = readGuardLog(dir).filter((e) => e.guard === "deliver");
    expect(events.length).toBeGreaterThanOrEqual(6);
    expect(events.every((e) => e.verdict === "pass")).toBe(true);
  });

  test("retains authored domain context and decisions", () => {
    const context = "# Domain language\n\nA lender keeps custody of each tool.\n";
    const decision = "# 2026-001: Loan terms\n\nThe return date is explicit.\n";
    const dir = proj({ "CONTEXT.md": context, "ADRs/2026-001-loan-terms.md": decision });
    const result = deliver(dir);
    expect(result.code).toBe(0);
    expect(readFileSync(join(dir, "CONTEXT.md"), "utf8")).toBe(context);
    expect(readFileSync(join(dir, "ADRs/2026-001-loan-terms.md"), "utf8")).toBe(decision);
  });

  test("ts-morph pin matches the version the pack itself uses", () => {
    const dir = proj();
    deliver(dir);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const agentPkg = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies["ts-morph"]).toBe(agentPkg.devDependencies["ts-morph"]);
  });

  test("BLOCK when a src file still imports NotImplementedError — names the file", () => {
    const dir = proj({
      "src/orders/orders.ts": `import { NotImplementedError } from "../shared/errors.js";
export type * from "./orders.contract.js";
export function placeOrder(id: string): never {
  throw new NotImplementedError("placeOrder");
}
`,
    });
    const r = deliver(dir);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/BLOCK/);
    expect(r.lines.join("\n")).toContain("src/orders/orders.ts");
    expect(r.lines.join("\n")).toMatch(/NotImplementedError/);
    // nothing was deleted
    expect(existsSync(join(dir, "src/shared/errors.ts"))).toBe(true);
    const events = readGuardLog(dir).filter((e) => e.guard === "deliver");
    expect(events.some((e) => e.verdict === "block")).toBe(true);
  });

  // The architect's scratch zone (Fix 4): a top-level scratch/ is the
  // architect's throwaway sandbox. deliver walks src/ and tests/ only, so a
  // scratch probe is neither scanned (its NotImplementedError import does not
  // block delivery), nor scaffolded, nor added to the barrel, nor touched.
  test("a top-level scratch/ is invisible to delivery — not scanned, not shipped, not touched", () => {
    const dir = proj({
      "scratch/probe.ts": 'import { NotImplementedError } from "../src/shared/errors.js";\nexport const probe: never = (() => { throw new NotImplementedError("probe"); })();\n',
      "scratch/probe.contract.ts": "export interface Probe {}\n",
    });
    const r = deliver(dir);
    expect(r.code).toBe(0);
    // The probe survived untouched — deliver never entered scratch/.
    expect(existsSync(join(dir, "scratch/probe.ts"))).toBe(true);
    expect(existsSync(join(dir, "scratch/probe.contract.ts"))).toBe(true);
    // And it is absent from the barrel: only the real src module is exported.
    const barrel = readFileSync(join(dir, "src/index.ts"), "utf8");
    expect(barrel).not.toMatch(/scratch|probe/);
    expect(barrel).toContain("orders/orders.js");
  });

  test("errors module is KEPT (not a block) when only tests/ import it", () => {
    const dir = proj({
      "tests/orders.test.ts": `import { NotImplementedError } from "../src/shared/errors.js";
void NotImplementedError;
`,
    });
    const r = deliver(dir);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "src/shared/errors.ts"))).toBe(true);
    expect(r.lines.join("\n")).toMatch(/kept/i);
  });

  test("BLOCK on a hand-written src/index.ts — merge is not a delivery step", () => {
    const dir = proj({ "src/index.ts": "export { placeOrder } from './orders/orders.js';\n" });
    const r = deliver(dir);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/index\.ts/);
    // untouched
    expect(readFileSync(join(dir, "src/index.ts"), "utf8")).toContain("export { placeOrder }");
  });

  test("appends to an existing README rather than clobbering it", () => {
    const dir = proj({ "README.md": "# fixture\n\nHand-written intro.\n" });
    const r = deliver(dir);
    expect(r.code).toBe(0);
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain("Hand-written intro.");
    expect(readme).toContain("## Contracts");
  });

  test("idempotent: the second run applies 0 steps and changes no file", () => {
    const dir = proj();
    const stub = surfaceStub();
    const npm = fakeNpm();
    expect(runDeliver(dir, { surfaceCheckSource: stub, run: npm.run }).code).toBe(0);
    const snapshot = new Map<string, string>();
    for (const rel of [
      "package.json",
      ".gitignore",
      "README.md",
      "src/index.ts",
      "src/orders/orders.ts",
      "scripts/surface-check.ts",
    ]) {
      snapshot.set(rel, readFileSync(join(dir, rel), "utf8"));
    }
    const r2 = runDeliver(dir, { surfaceCheckSource: stub, run: npm.run });
    expect(r2.code).toBe(0);
    expect(r2.lines.at(-1)).toBe("deliver: OK — 0 steps applied");
    for (const [rel, content] of snapshot) {
      expect(readFileSync(join(dir, rel), "utf8")).toBe(content);
    }
    // .bounded/ not duplicated in .gitignore
    const ignoreLines = readFileSync(join(dir, ".gitignore"), "utf8").split("\n").filter((l) => l === ".bounded/");
    expect(ignoreLines).toHaveLength(1);
  });

  test("preserves a project-local harness ignore rule and its committed exceptions", () => {
    const dir = proj({
      ".gitignore": ".bounded/*\n!.bounded/harness/\n!.bounded/composed-packs.json\n!.bounded/installation.json\n",
    });
    const original = readFileSync(join(dir, ".gitignore"), "utf8");
    const r = runDeliver(dir, { surfaceCheckSource: surfaceStub(), run: fakeNpm().run });
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(original);
  });

  test("misuse: missing surface checker source is exit 2, before any mutation", () => {
    const dir = proj();
    const r = runDeliver(dir, { surfaceCheckSource: join(dir, "does-not-exist.ts") });
    expect(r.code).toBe(2);
    // step 1 did not run
    expect(existsSync(join(dir, "src/shared/errors.ts"))).toBe(true);
  });

  test("misuse: target without src/ or package.json is exit 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-deliver-empty-"));
  writeProjectPacks(dir, ["ts"]);
    tmpDirs.push(dir);
    const r = runDeliver(dir, { surfaceCheckSource: surfaceStub(), run: fakeNpm().run });
    expect(r.code).toBe(2);
  });
});

// The red-phase shadow project (ADR 2026-021). red_gate rebuilds `.bounded/shadow-red/`
// from the contracts, regenerated skeletons and a copy of the tests tree, so the
// red is proven without ever reading the live `src/`. That copy is the run's
// scaffolding, not the deliverable: left behind, it is a duplicate of the tests
// sitting beside the real ones, and a reader has no way to tell which is which.
// --- TSX implementations are paired like any other (TN-26-006 A1) ------------
//
// Pairing is how delivery finds the work: a contract whose implementation it
// cannot see gets no __conformance strip and no barrel line. A component
// contract is implemented by a `.tsx` sibling, so a pairing rule that only
// knew `.ts` would ship a frontend whose modules are absent from its own
// public API and still carry the scaffolder's compile-time blob.

const COMPONENT_CONTRACT_TS = `import type { ReactElement } from "react";

export interface BadgeProps {
  readonly tone: "ok" | "warn";
}

export declare function Badge(props: BadgeProps): ReactElement;
`;

const COMPONENT_IMPL_TSX = `import type { ReactElement } from "react";
import type { BadgeProps } from "./badge.contract.js";
import type * as __Contract from "./badge.contract.js";

export type * from "./badge.contract.js";

export function Badge(props: BadgeProps): ReactElement {
  return <span className={props.tone}>{props.tone}</span>;
}

// Compile-time conformance: every scaffoldable value export of the contract
// exists above, with the signature the contract declared.
const __conformance: Pick<typeof __Contract, "Badge"> = { Badge };
void __conformance;
`;

describe("runDeliver pairs a .tsx implementation", () => {
  test("its conformance blob is stripped and it reaches the barrel as .js", () => {
    const dir = proj({
      "src/ui/badge.contract.ts": COMPONENT_CONTRACT_TS,
      "src/ui/badge.tsx": COMPONENT_IMPL_TSX,
    });
    const r = deliver(dir);
    expect(r.code).toBe(0);

    const impl = readFileSync(join(dir, "src/ui/badge.tsx"), "utf8");
    expect(impl).not.toMatch(/__conformance|__Contract/);
    // JSX survives the strip intact — it is a text excision, and it must not
    // have been parsed as a `.ts` file where `<span …>` is a type assertion.
    expect(impl).toContain("return <span className={props.tone}>{props.tone}</span>;");
    expect(impl).toContain('export type * from "./badge.contract.js";');

    const barrel = readFileSync(join(dir, "src/index.ts"), "utf8");
    expect(barrel).toContain('export * from "./ui/badge.js";');
    expect(barrel).toContain('export * from "./orders/orders.js";');
    expect(barrel).not.toContain(".tsx");

    const stripped = readGuardLog(dir).find((e) => e.summary?.startsWith("stripped __conformance"));
    expect(stripped?.summary).toContain("src/ui/badge.tsx");
  });

  // The r16 defect wears any extension: an export that still throws
  // NotImplementedError is not delivered, whatever the suite said.
  test("BLOCK when a .tsx is still a throwing skeleton", () => {
    const dir = proj({
      "src/ui/badge.contract.ts": COMPONENT_CONTRACT_TS,
      "src/ui/badge.tsx": `import { NotImplementedError } from "../shared/errors.js";
import type { ReactElement } from "react";
import type { BadgeProps } from "./badge.contract.js";

export type * from "./badge.contract.js";

export function Badge(props: BadgeProps): ReactElement {
  throw new NotImplementedError("Badge");
}
`,
    });
    const r = deliver(dir);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain("src/ui/badge.tsx");
    expect(r.lines.join("\n")).toMatch(/NotImplementedError/);
  });
});

describe("runDeliver: the red-phase shadow", () => {
  test("removes .bounded/shadow-red/ and says so", () => {
    const dir = proj({
      ".bounded/shadow-red/package.json": "{}\n",
      ".bounded/shadow-red/tests/orders.test.ts": "// a copy of the real suite\n",
    });
    const r = deliver(dir);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, ".bounded/shadow-red"))).toBe(false);
    expect(r.lines).toContain("deliver: shadow — removed .bounded/shadow-red/ (red_gate rebuilds it on demand)");
  });

  test("the removal is logged as its own guard event", () => {
    const dir = proj({ ".bounded/shadow-red/package.json": "{}\n" });
    deliver(dir);
    const event = readGuardLog(dir).find(
      (e) => e.guard === "deliver" && (e.detail as { step?: string } | undefined)?.step === "shadow",
    );
    expect(event?.verdict).toBe("pass");
    expect(event?.summary).toContain("removed .bounded/shadow-red/");
  });

  test("idempotent: a project with no shadow is untouched and applies no step", () => {
    const dir = proj();
    const first = deliver(dir);
    expect(first.lines).toContain("deliver: shadow — no .bounded/shadow-red/ to remove");
    const second = deliver(dir);
    expect(second.lines.at(-1)).toBe("deliver: OK — 0 steps applied");
  });

  test("the rest of .bounded/ survives — the guard log is the run's record", () => {
    const dir = proj({ ".bounded/shadow-red/package.json": "{}\n" });
    deliver(dir);
    expect(existsSync(join(dir, ".bounded"))).toBe(true);
    expect(readGuardLog(dir).length).toBeGreaterThan(0);
  });
});

// Issue #13: every run should report where its minutes went. The measurement
// was already in the guard log — delivery is where it finally gets read back.
describe("runDeliver: phase timing", () => {
  test("prints the phase block from the project's own guard log", () => {
    const dir = proj({ ".bounded/guard-log.jsonl": SEEDED_GUARD_LOG });
    const r = deliver(dir);
    expect(r.code).toBe(0);
    const out = r.lines.join("\n");
    expect(out).toMatch(/^deliver: timing — where the minutes went \(\d+ guard events, taken as one run\)$/m);
    expect(r.lines).toContain("  timing: design    4m00s");
    expect(r.lines).toContain("  timing: tests    16m00s  (1 bounce: 1 → test-writer)");
    expect(r.lines).toContain("  timing: build    28m00s");
    // WRAP is closed by this very delivery's own events, so its span is live
    // wall clock — assert it was measured, not what it measured to.
    expect(out).toMatch(/^ {2}timing: wrap\s+\d+[hms]/m);
    // A clean run still says so: zero is the target, and a line that appears
    // only when there is friction makes "clean" and "unmeasured" look alike.
    expect(r.lines).toContain("  friction: 0 refusals — target 0");
  });

  // Bounces are the pipeline working; unrouted blocks are the harness getting
  // in the way, and r14 ended a run with 17 of them without any single line
  // ever saying so. The guard breakdown is what points at the fix.
  test("the friction line totals the unrouted blocks and names the guards", () => {
    const dir = proj({ ".bounded/guard-log.jsonl": FRICTION_GUARD_LOG });
    const r = deliver(dir);
    expect(r.code).toBe(0);
    expect(r.lines).toContain("  friction: 3 refusals (path-gate 2, phase-gate 1) — target 0");
    // ...and the same numbers ride in the event detail, not a second tally.
    const event = readGuardLog(dir).find(
      (e) => e.guard === "deliver" && (e.detail as { step?: string } | undefined)?.step === "timing",
    );
    const timing = (event!.detail as { timing?: PhaseDurations }).timing!;
    expect(timing.friction).toEqual({
      refusals: 3,
      refusalsByGuard: [
        { guard: "path-gate", count: 2 },
        { guard: "phase-gate", count: 1 },
      ],
      iteration: 0,
      iterationByGuard: [],
      unroutedBlocks: 3,
    });
  });

  test("the structured summary rides along in the deliver guard event's detail", () => {
    const dir = proj({ ".bounded/guard-log.jsonl": SEEDED_GUARD_LOG });
    deliver(dir);
    const event = readGuardLog(dir).find(
      (e) => e.guard === "deliver" && (e.detail as { step?: string } | undefined)?.step === "timing",
    );
    expect(event).toBeDefined();
    const timing = (event!.detail as { timing?: PhaseDurations }).timing!;
    expect(timing.phases.map((p) => p.phase)).toEqual(["design", "tests", "build", "wrap"]);
    expect(timing.phases[0]!.ms).toBe(4 * 60_000);
    expect(timing.phases[1]!.byRoute).toEqual([{ route: "test-writer", count: 1 }]);
    expect(timing.bounces).toBe(1);
  });

  test("timing is read-only: it applies no step and the second run reports again", () => {
    const dir = proj({ ".bounded/guard-log.jsonl": SEEDED_GUARD_LOG });
    const stub = surfaceStub();
    const npm = fakeNpm();
    runDeliver(dir, { surfaceCheckSource: stub, run: npm.run });
    const second = runDeliver(dir, { surfaceCheckSource: stub, run: npm.run });
    expect(second.lines.at(-1)).toBe("deliver: OK — 0 steps applied");
    expect(second.lines).toContain("  timing: design    4m00s");
  });

  test("an unavailable log costs one line, never the delivery", () => {
    // BOUNDED_GUARD_LOG=off is the real way a project ends up with no log at all:
    // nothing was ever written, including this delivery's own events.
    const dir = proj();
    process.env["BOUNDED_GUARD_LOG"] = "off";
    try {
      const r = deliver(dir);
      expect(r.code).toBe(0);
      expect(r.lines).toContain(
        "deliver: timing — unavailable — the guard log is empty or absent (BOUNDED_GUARD_LOG=off, or no gate ran here)",
      );
      expect(r.lines.at(-1)).toMatch(/^deliver: OK — \d+ steps applied$/);
    } finally {
      delete process.env["BOUNDED_GUARD_LOG"];
    }
    // the repo was still delivered
    expect(existsSync(join(dir, "src/index.ts"))).toBe(true);
  });
});

// r15: BOTH delivered repos failed their own `npm run check`. deliver pinned
// ts-morph into package.json for the shipped surface checker and never
// installed it (ERR_MODULE_NOT_FOUND), and nothing in the whole pipeline ever
// ran the project's canonical check command, so nobody found out until a human
// typed it. Two halves, two fixes: materialize what you pin, and ask the repo
// whether it satisfies its own definition of done.
describe("runDeliver: the shipped surface check must actually resolve", () => {
  test("installs the pinned ts-morph, exactly that dependency, in the target", () => {
    const dir = proj();
    const npm = fakeNpm();
    const r = runDeliver(dir, { surfaceCheckSource: surfaceStub(), run: npm.run });
    expect(r.code).toBe(0);

    const pin = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).devDependencies["ts-morph"];
    const install = npm.calls.find((c) => c.args[0] === "install");
    expect(install).toBeDefined();
    expect(install!.command).toBe(process.platform === "win32" ? "npm.cmd" : "npm");
    expect(install!.args).toEqual([
      "install",
      "--save-dev",
      "--save-exact",
      "--no-audit",
      "--no-fund",
      `ts-morph@${pin}`,
    ]);
    expect(install!.cwd).toBe(dir);
    expect(existsSync(join(dir, "node_modules/ts-morph/package.json"))).toBe(true);
    expect(r.lines.join("\n")).toContain(`installed ts-morph@${pin}`);
  });

  test("does not install again when node_modules/ts-morph already resolves", () => {
    const dir = proj();
    deliver(dir); // first delivery installs
    const npm = fakeNpm();
    const second = runDeliver(dir, { surfaceCheckSource: surfaceStub(), run: npm.run });
    expect(second.code).toBe(0);
    expect(second.lines.at(-1)).toBe("deliver: OK — 0 steps applied");
    expect(npm.calls.map((c) => c.args[0])).toEqual(["run"]);
  });

  test("BLOCK when the install fails — no repo ships with a check that cannot run", () => {
    const dir = proj();
    const npm = fakeNpm({
      install: { code: 1, stdout: "", stderr: "npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org failed" },
    });
    const r = runDeliver(dir, { surfaceCheckSource: surfaceStub(), run: npm.run });
    expect(r.code).toBe(1);
    const out = r.lines.join("\n");
    expect(out).toMatch(/^deliver: BLOCK — could not install ts-morph@/m);
    expect(out).toContain("ERR_MODULE_NOT_FOUND");
    expect(r.lines).toContain("  install: npm error code ENOTFOUND");
    // the project's own check never ran: the tree is not deliverable
    expect(npm.calls.map((c) => c.args[0])).toEqual(["install"]);
    const event = readGuardLog(dir).find((e) => e.guard === "deliver" && e.verdict === "block");
    expect((event!.detail as { step?: string }).step).toBe("surface-check");
  });

  test("BLOCK when npm claims success but ts-morph still does not resolve", () => {
    const dir = proj();
    const npm = fakeNpm({ materialize: false });
    const r = runDeliver(dir, { surfaceCheckSource: surfaceStub(), run: npm.run });
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain("npm reported success but node_modules/ts-morph is still missing");
  });
});

describe("runDeliver: the project's own check (final step)", () => {
  test("runs `npm run check` in the target and prints its summary line", () => {
    const dir = proj();
    const npm = fakeNpm();
    const r = runDeliver(dir, { surfaceCheckSource: surfaceStub(), run: npm.run });
    expect(r.code).toBe(0);
    expect(r.lines).toContain("deliver: check — npm run check passed — Tests  5 passed (5)");

    const check = npm.calls.find((c) => c.args[0] === "run");
    expect(check!.args).toEqual(["run", "check"]);
    expect(check!.cwd).toBe(dir);
  });

  test("it is last of deliver's OWN steps: it sees the delivered tree, after the timing block", () => {
    const dir = proj({ ".bounded/guard-log.jsonl": SEEDED_GUARD_LOG });
    const npm = fakeNpm();
    const r = runDeliver(dir, { surfaceCheckSource: surfaceStub(), run: npm.run });
    // the barrel — the last mutating step's output — existed when check ran
    expect(npm.calls.find((c) => c.args[0] === "run")!.barrelPresent).toBe(true);
    const timingAt = r.lines.findIndex((l) => l.startsWith("deliver: timing —"));
    const checkAt = r.lines.findIndex((l) => l.startsWith("deliver: check —"));
    expect(timingAt).toBeGreaterThanOrEqual(0);
    expect(checkAt).toBeGreaterThan(timingAt);
    // Only the pack-contributed checks (ADR 2026-033) and the OK summary
    // follow — every step that MUTATES the tree ran before it.
    const after = r.lines.slice(checkAt + 1);
    expect(after.at(-1)).toMatch(/^deliver: OK —/);
    expect(after.slice(0, -1).every((l) => l.startsWith("deliver: ") || l.startsWith("  "))).toBe(
      true,
    );
  });

  test("BLOCK when the project's own check is red, with the failing tail", () => {
    const dir = proj({ ".bounded/guard-log.jsonl": SEEDED_GUARD_LOG });
    const npm = fakeNpm({
      check: {
        code: 1,
        stdout: "src/orders/orders.ts(4,3): error TS2322: Type 'number' is not assignable to type 'string'.\n",
        stderr: "npm error Lifecycle script `check` failed with error:\n",
      },
    });
    const r = runDeliver(dir, { surfaceCheckSource: surfaceStub(), run: npm.run });
    expect(r.code).toBe(1);
    expect(r.lines).toContain(
      "deliver: BLOCK — the project's own `npm run check` is RED (npm exited 1) — the repo does not " +
        "satisfy its own definition of done, so it is not ready to hand over; fix it and re-run deliver",
    );
    expect(r.lines).toContain(
      "  check: src/orders/orders.ts(4,3): error TS2322: Type 'number' is not assignable to type 'string'.",
    );
    // the timing report still made it out — the block is the headline, but the
    // minutes are what nobody can reconstruct afterwards
    expect(r.lines.findIndex((l) => l.startsWith("deliver: timing —"))).toBeGreaterThanOrEqual(0);
    expect(r.lines.findIndex((l) => l.startsWith("deliver: BLOCK —"))).toBeGreaterThan(
      r.lines.findIndex((l) => l.startsWith("deliver: timing —")),
    );
    const event = readGuardLog(dir).find((e) => e.guard === "deliver" && e.verdict === "block");
    expect((event!.detail as { step?: string }).step).toBe("check");
  });

  test("a check that never completes (timeout) blocks too", () => {
    const dir = proj();
    const r = runDeliver(dir, {
      surfaceCheckSource: surfaceStub(),
      run: fakeNpm({ check: { code: null, stdout: "", stderr: "spawnSync npm ETIMEDOUT" } }).run,
    });
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain("is RED (it never completed)");
  });
});

describe("checkSummaryLine (pure)", () => {
  test("prefers vitest's test tally", () => {
    expect(checkSummaryLine(CHECK_OK)).toBe("Tests  5 passed (5)");
  });

  test("falls back to the last line when the check speaks another language", () => {
    expect(checkSummaryLine({ code: 0, stdout: "all good\n\n", stderr: "" })).toBe("all good");
  });

  test("strips ANSI colour so the line is greppable", () => {
    const coloured = { code: 0, stdout: "\u001b[32m Tests  3 passed (3)\u001b[39m\n", stderr: "" };
    expect(checkSummaryLine(coloured)).toBe("Tests  3 passed (3)");
  });

  test("silent output has no summary to print", () => {
    expect(checkSummaryLine({ code: 0, stdout: "", stderr: "" })).toBeUndefined();
  });
});

// The seam above can be wired perfectly to a fake and still be wrong about the
// real npm, so exactly ONE test spawns it. It is skipped rather than failed
// when the registry is unreachable: offline is a legitimate state to develop
// this repo in, and a network flake must never turn the suite red.
describe("runDeliver: the real npm install (integration)", () => {
  test("materializes ts-morph in the target for real", { timeout: 300_000 }, (ctx) => {
    const dir = proj({}, {
      "package.json": '{\n  "name": "install-it",\n  "private": true,\n  "type": "module"\n}\n',
      "src/orders/orders.contract.ts": CONTRACT_TS,
      "src/orders/orders.ts": IMPL_TS,
    });
    // Real install, faked check: a real `npm run check` would need the
    // fixture's whole toolchain too, which is a different and far slower test.
    const r = runDeliver(dir, {
      surfaceCheckSource: surfaceStub(),
      run: (command, args, cwd) => (args[0] === "install" ? spawnRun(command, args, cwd) : CHECK_OK),
    });
    if (r.code !== 0) {
      ctx.skip(`npm install unavailable here (offline?): ${r.lines.at(-1)}`);
      return;
    }
    expect(existsSync(join(dir, "node_modules", "ts-morph", "package.json"))).toBe(true);
    const pin = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).devDependencies["ts-morph"];
    const installed = JSON.parse(
      readFileSync(join(dir, "node_modules", "ts-morph", "package.json"), "utf8"),
    ) as { version: string };
    expect(installed.version).toBe(pin);
  });
});

// --- 5b. blessed stack pins (ADR 2026-029, TN-26-004) ---------------------------

describe("blessed stack pins", () => {
  const RUNTIME_STUB =
    "// GENERATED from packs/ts-trpc/api/service-runtime.ts by packs/ts/scripts/scaffold-contract.ts — do not edit.\nexport const rt = true;\n";

  test("zod import and a shipped runtime pin and install both, as dependencies (ts-trpc composed)", () => {
    const dir = proj({
      "src/values/values.ts":
        'import { z } from "zod";\nexport const schema = z.string();\n',
      "src/api/service-runtime.ts": RUNTIME_STUB,
    });
    writeProjectPacks(dir, ["ts", "ts-hexagonal", "ts-trpc"]);
    const npm = fakeNpm();
    const r = runDeliver(dir, { surfaceCheckSource: surfaceStub(), run: npm.run });
    // ts-trpc's own delivery check blocks this router-less fixture later;
    // the pins step before it is what this test is about.
    expect(r.lines.some((l) => /stack-pins — pinned zod@[\d.]+, installed zod@/.test(l))).toBe(true);
    expect(r.lines.some((l) => /pinned @trpc\/server@[\d.]+/.test(l))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["zod"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies["@trpc/server"]).toMatch(/^\d+\.\d+\.\d+$/);
    // Regular dependencies — both are imported by shipped src/**.
    const installs = npm.calls.filter((c) => c.args[0] === "install").map((c) => c.args.at(-1));
    expect(installs.some((s) => s?.startsWith("zod@"))).toBe(true);
    expect(installs.some((s) => s?.startsWith("@trpc/server@"))).toBe(true);
  });

  test("with only ts composed, a runtime-shaped file pins no service framework (ADR 2026-046)", () => {
    const dir = proj({ "src/api/service-runtime.ts": RUNTIME_STUB });
    const npm = fakeNpm();
    const r = runDeliver(dir, { surfaceCheckSource: surfaceStub(), run: npm.run });
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => l.includes("@trpc/server"))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["@trpc/server"]).toBeUndefined();
  });

  test("a tree using neither stack pins nothing", () => {
    const dir = proj();
    const npm = fakeNpm();
    const r = runDeliver(dir, { surfaceCheckSource: surfaceStub(), run: npm.run });
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => l.includes("stack-pins — no blessed stacks in use"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["zod"]).toBeUndefined();
  });

  test("a failed stack install blocks the delivery", () => {
    const dir = proj({
      "src/values/values.ts": 'import { z } from "zod";\nexport const schema = z.string();\n',
    });
    // ts-morph resolves already so step 5 never installs; the zod install fails.
    mkdirSync(join(dir, "node_modules", "ts-morph"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "ts-morph", "package.json"), '{"name":"ts-morph"}\n');
    const pkgAbs = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgAbs, "utf8")) as Record<string, unknown>;
    pkg["devDependencies"] = { "ts-morph": "1.0.0" };
    writeFileSync(pkgAbs, JSON.stringify(pkg, null, 2) + "\n");
    const npm = fakeNpm({ install: { code: 1, stdout: "", stderr: "ENETDOWN" } });
    const r = runDeliver(dir, { surfaceCheckSource: surfaceStub(), run: npm.run });
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/could not install zod@/);
  });
});

// --- step 10: the checks other packs contribute (ADR 2026-033) ---------------
//
// The socket is read through the real composition, so these tests exercise the
// wiring end to end: ts-trpc's and ts-web's delivery obligations are keyed on
// the tree — a project that composed them must carry a generated tRPC adapter
// and a whole web app, and one missing a piece stops the handover.

/** A composed web project's tree: the generated tRPC barrel and the web app's door. */
function webFiles(): Record<string, string> {
  return {
    ".bounded/composed-packs.json": '["ts", "ts-hexagonal", "ts-trpc", "ts-web"]',
    "contexts/orders/src/adapters/in/trpc/index.ts": "export {};\n",
    "apps/web/src/client/index.html": "<!doctype html>\n",
    "apps/web/src/client/main.tsx": "export {};\n",
    "apps/web/src/server/main.ts": "export {};\n",
    "apps/web/src/server/composition-root.ts": "export {};\n",
  };
}

describe("runDeliver: pack-contributed checks", () => {
  test("a contributed check runs, is named in its own line, and is never an applied step", () => {
    const dir = proj(webFiles());
    const r = deliver(dir);
    expect(r.code).toBe(0);
    expect(r.lines.join("\n")).toContain("deliver: trpc-obligation —");
    expect(r.lines.join("\n")).toContain("deliver: web-obligation —");
    // read-only: a second delivery still reports zero steps applied
    expect(deliver(dir).lines.at(-1)).toBe("deliver: OK — 0 steps applied");
  });

  test("a project that composed no pack with a check passes with nothing to check", () => {
    const r = deliver(proj());
    expect(r.lines.join("\n")).toContain("pack-checks — no composed pack contributes one");
  });

  test("a contributed check that blocks stops the delivery, with its detail lines", () => {
    const files = webFiles();
    delete files["apps/web/src/client/main.tsx"];
    const dir = proj(files);
    const r = deliver(dir);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain("deliver: BLOCK — web-obligation:");
    expect(r.lines.join("\n")).toContain("apps/web/src/client/main.tsx");
    expect(readGuardLog(dir).some((e) => e.verdict === "block")).toBe(true);
  });

  // It runs AFTER the project's own check, so a red repo never reaches it —
  // the remedy is the same either way (fix it and re-run deliver), and the
  // block that matters is printed first.
  test("a red `npm run check` short-circuits it", () => {
    const files = webFiles();
    delete files["apps/web/src/client/main.tsx"];
    const r = deliver(proj(files), { check: { code: 1, stdout: "1 failed", stderr: "" } });
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain("npm run check` is RED");
    expect(r.lines.join("\n")).not.toContain("web-obligation");
  });
});

describe("runDeliver: folded check scripts", () => {
  // Keyed on the tree: a pure service composed under the same harness gets no
  // build folded into its check and nothing to build.
  test("a service (no bootstrap) folds no build script and passes build-check", () => {
    const dir = proj();
    const r = deliver(dir);
    expect(r.code).toBe(0);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.scripts["check:build"]).toBeUndefined();
    expect(pkg.scripts.check).not.toContain("check:build");
    expect(r.lines.join("\n")).not.toContain("deliver: build-check");
    expect(r.lines.join("\n")).toMatch(/check-scripts — no composed pack folds/);
  });
});
