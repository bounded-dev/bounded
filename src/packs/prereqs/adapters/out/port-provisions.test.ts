import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ports } from "bounded/domain";
import { fileSetFingerprintsPort, prerequisiteRecordsPort } from "../../application/check-prerequisites/check-prerequisites.contract.ts";
import { prereqsPortProvisions } from "./port-provisions.ts";

describe("prereqsPortProvisions", () => {
  test("provides the two ports, frozen", () => {
    const provisions = prereqsPortProvisions();
    expect(provisions.length).toBe(2);
    expect(Object.isFrozen(provisions)).toBe(true);
    const ports = Ports.forProject(mkdtempSync(join(tmpdir(), "prereqs-provisions-")), provisions);
    expect(ports.ok).toBe(true);
    if (!ports.ok) return;
    expect(ports.value.provides(fileSetFingerprintsPort)).toBe(true);
    expect(ports.value.get(fileSetFingerprintsPort).ok).toBe(true);
    expect(ports.value.provides(prerequisiteRecordsPort)).toBe(true);
    expect(ports.value.get(prerequisiteRecordsPort).ok).toBe(true);
  });
});
