import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  GUARD_LOG_RELATIVE,
  guardLogPath,
  logGuardEvent,
  readGuardLog,
} from "./guard-log.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "guard-log-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env["BOUNDED_GUARD_LOG"];
});

describe("guard log (TN-26-001: a deterministic system that is opaque when it jams is just a deterministic jam)", () => {
  test("writes one JSON line per event, creating .bounded/ in the target project", () => {
    const cwd = tmp();
    logGuardEvent(cwd, {
      guard: "contract-purity",
      verdict: "block",
      summary: "1 problem in 1 file",
      detail: { file: "src/x.contract.ts", ruleId: "bounded-ts/declaration-only" },
    });
    const raw = readFileSync(guardLogPath(cwd), "utf8");
    expect(GUARD_LOG_RELATIVE).toBe(".bounded/guard-log.jsonl");
    const event = JSON.parse(raw.trim());
    expect(event.guard).toBe("contract-purity");
    expect(event.verdict).toBe("block");
    expect(event.summary).toBe("1 problem in 1 file");
    expect(event.detail.file).toBe("src/x.contract.ts");
    expect(typeof event.ts).toBe("string"); // ISO timestamp
  });

  test("appends across guards — the log is a timeline", () => {
    const cwd = tmp();
    logGuardEvent(cwd, { guard: "scaffold", verdict: "pass", summary: "wrote src/orders/orders.ts" });
    logGuardEvent(cwd, { guard: "contract-purity", verdict: "pass", summary: "OK (2 files)" });
    const events = readGuardLog(cwd);
    expect(events.map((e) => `${e.guard}:${e.verdict}`)).toEqual([
      "scaffold:pass",
      "contract-purity:pass",
    ]);
  });

  test("readGuardLog skips unparseable lines rather than dying", () => {
    const cwd = tmp();
    logGuardEvent(cwd, { guard: "scaffold", verdict: "pass", summary: "ok" });
    writeFileSync(guardLogPath(cwd), readFileSync(guardLogPath(cwd), "utf8") + "not json\n");
    expect(readGuardLog(cwd)).toHaveLength(1);
  });

  test("BOUNDED_GUARD_LOG=off opts out", () => {
    const cwd = tmp();
    process.env["BOUNDED_GUARD_LOG"] = "off";
    logGuardEvent(cwd, { guard: "scaffold", verdict: "pass", summary: "ok" });
    expect(readGuardLog(cwd)).toEqual([]);
  });

  test("logging never breaks the caller (unwritable path is swallowed)", () => {
    // A regular file as the "project directory": mkdir under it fails with
    // ENOTDIR at once on every platform. NOT a path under /proc — on Linux
    // procfs answers mkdir with ENOENT while the parent exists, and Node's
    // recursive mkdir then loops between child and parent forever, which no
    // try/catch can end. That is a hang, not a throw, and it took the whole
    // suite with it on Linux (CI runs ubuntu-latest); macOS has no /proc, so
    // it threw fast there and the suite looked green.
    const parent = join(tmp(), "not-a-directory");
    writeFileSync(parent, "");
    expect(() =>
      logGuardEvent(parent, {
        guard: "scaffold",
        verdict: "pass",
        summary: "ok",
      }),
    ).not.toThrow();
    expect(readGuardLog(parent)).toEqual([]);
  });
});
