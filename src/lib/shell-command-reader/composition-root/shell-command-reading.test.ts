import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "bounded/domain";
import { openShellCommandReading } from "./shell-command-reading.ts";

describe("openShellCommandReading", () => {
  test("reads with bounded's tree-sitter reader: a redirect to a new file is a create, in a reading Effect.parse accepts", async () => {
    const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "bounded-shell-command-reading-")));
    const command = "echo x > out.txt";
    const reading = await openShellCommandReading().read({ projectRoot, command, cwd: null });
    expect(reading.outcome).toBe("read");
    expect(reading.outcome === "read" && reading.fileEffects).toContainEqual({ effect: { kind: "write", path: "out.txt", change: "create" } });
    expect(Effect.parse({ kind: "execute", command, reading }).ok).toBe(true);
  });

  test("refuses a readWithinMs that is not a finite number above zero", () => {
    expect(() => openShellCommandReading({ readWithinMs: 0 })).toThrow(new RangeError("readWithinMs must be a finite number of milliseconds above zero"));
  });
});
