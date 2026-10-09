import { describe, expect, test } from "bun:test";
import { packIdsFor } from "../packs/pack-id.ts";
import { portKeysFor } from "./port-key.ts";
import { Ports } from "./ports.ts";

interface Files {
  read(path: string): string;
}
const owner = packIdsFor("test-packs")("gate");
const files = portKeysFor(owner)<Files>("files");
const snapshots = portKeysFor(owner)<{ take(): string }>("snapshots");
const fixed: Files = { read: (path) => `content of ${path}` };

describe("Ports — the adapters a host provides for one project", () => {
  test("gives the adapter for a key, opened for the project's root", () => {
    const roots: string[] = [];
    const ports = Ports.forProject("/work/project", [
      Ports.provide(files, (root) => {
        roots.push(root);
        return fixed;
      }),
    ]);
    const got = ports.ok ? ports.value.get(files) : undefined;
    expect(got?.ok && got.value.read("a.ts")).toBe("content of a.ts");
    expect(roots).toEqual(["/work/project"]);
  });

  test("opens each adapter lazily, at most once", () => {
    let opened = 0;
    const ports = Ports.forProject("/work/project", [
      Ports.provide(files, () => {
        opened++;
        return fixed;
      }),
    ]);
    expect(opened).toBe(0);
    if (ports.ok) {
      ports.value.get(files);
      ports.value.get(files);
    }
    expect(opened).toBe(1);
  });

  test("a port that is not provided is an error naming the pack, the port and the fix", () => {
    const ports = Ports.forProject("/work/project", []);
    expect(ports.ok && ports.value.get(snapshots)).toEqual({ ok: false, error: "test-packs/gate needs the port 'snapshots', which this host does not provide: pass it to openProject({ ports })" });
    expect(ports.ok && ports.value.provides(snapshots)).toBe(false);
  });

  test("an adapter that cannot be opened is an error, every time it is asked for", () => {
    const ports = Ports.forProject("/work/project", [
      Ports.provide(files, () => {
        throw new Error("no disk");
      }),
    ]);
    const error = { ok: false as const, error: "test-packs/gate could not open the port 'files': no disk" };
    expect(ports.ok && ports.value.get(files)).toEqual(error);
    expect(ports.ok && ports.value.get(files)).toEqual(error);
  });

  test("keys meet by owner and name, so two copies of a pack's key find the same adapter", () => {
    const again = portKeysFor(packIdsFor("test-packs")("gate"))<Files>("files");
    const ports = Ports.forProject("/work/project", [Ports.provide(files, () => fixed)]);
    expect(ports.ok && ports.value.provides(again)).toBe(true);
    expect(ports.ok && ports.value.get(again).ok).toBe(true);
  });

  test("refuses two provisions for the same port", () => {
    expect(Ports.forProject("/work/project", [Ports.provide(files, () => fixed), Ports.provide(files, () => fixed)])).toEqual({
      ok: false,
      error: "The port 'files' of test-packs/gate is provided twice: provide each port once",
    });
  });

  test("refuses provisions that Ports.provide did not make", () => {
    expect(Ports.forProject("/work/project", [{ key: files } as never])).toEqual({ ok: false, error: "A port provision is made by Ports.provide(key, open)" });
  });
});
