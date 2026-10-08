import { describe, expect, test } from "bun:test";
import { packIdsFor } from "../packs/pack-id.ts";
import { PortKey, portKeysFor } from "./port-key.ts";

const owner = packIdsFor("test-packs")("gate");
const ports = portKeysFor(owner);

describe("PortKey — a slot for an adapter a pack needs", () => {
  test("is owned by a pack and named, and reads as <owner>#<name>", () => {
    const key = ports<{ read(): string }>("files");
    expect(key.owner).toBe(owner);
    expect(key.name).toBe("files");
    expect(key.toJSON()).toBe("test-packs/gate#files");
    expect(Object.isFrozen(key)).toBe(true);
  });

  test("two keys with the same owner and name are equal, whatever object holds them", () => {
    expect(ports("files").equals(portKeysFor(packIdsFor("test-packs")("gate"))("files"))).toBe(true);
    expect(ports("files").equals(ports("snapshots"))).toBe(false);
  });

  test("parses its wire form, refusing a name that is not camelCase or an owner that is not a pack id", () => {
    const parsed = PortKey.parse("test-packs/gate#files");
    expect(parsed.ok && parsed.value.equals(ports("files"))).toBe(true);
    const form = "A port key is '<pack id>#<name>', its name a camelCase word, such as 'bounded/path-gate#watchedFiles'";
    for (const raw of ["test-packs/gate", "test-packs/gate#Files", "test-packs/gate#a.b", "Gate#files", "#files", 7]) expect(PortKey.parse(raw)).toEqual({ ok: false, error: form });
  });
});
