import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { composePacks } from "../src/socket-registry.ts";
import { installedPacks, INSTALLED_PACKS } from "./installed.ts";
import { artifactGenerators, contractPurityOverrides, contractSupportFiles, deliverChecks, lintSrcRules, skeletonEmitters, TS_PACK } from "./ts/pack.ts";
import { TS_DRIZZLE_POSTGRES_PACK } from "./ts-drizzle-postgres/pack.ts";
import { TS_WEB_PACK } from "./ts-web/pack.ts";

// The real composition, composed for real. socket-registry.test.ts proves the
// mechanism with synthetic packs; this file proves that the harness's own packs
// are wired to it — the half that silently rots when someone adds a pack and
// forgets the list, or renames a socket and updates only one side.

describe("the harness's own composition", () => {
  test("composes without a refusal", () => {
    expect(() => installedPacks()).not.toThrow();
  });

  test("is memoized — a gate reads the same registry every call", () => {
    expect(installedPacks()).toBe(installedPacks());
  });

  test("composes ts before every pack that declares the edge to it", () => {
    expect(installedPacks().packs).toEqual([
      TS_PACK, "ts-hexagonal", "ts-desktop", TS_DRIZZLE_POSTGRES_PACK, "ts-lambda", "ts-mcp",
      "ts-service", TS_WEB_PACK,
    ]);
  });

  // The socket vocabulary is closed and curated (TN-26-005): a socket is born
  // with the machinery that consumes it, and ordinary packs are
  // contribution-only. ts is the foundational pack, so ts owns every socket
  // there is; a new socket appearing here without an ADR behind it is the
  // drift this test exists to make visible.
  test("the ts pack owns every socket, and nothing else defines one", () => {
    const sockets = installedPacks().sockets;
    expect(sockets.map((s) => s.id)).toEqual([
      // ADR 2026-055: born with its consumer, the generate_artifacts gate.
      "artifactGenerators",
      "contractPurityOverrides",
      // ADR 2026-046: born with its consumers, the scaffolder and red gate.
      "contractSupportFiles",
      // ADR 2026-033: born with its consumer, deliver's last step.
      "deliverChecks",
      "lintSrcRules",
      // ADR 2026-060: born with its consumers, the design gate's scaffold
      // step, the red gate's shadow and delivery's leftover check.
      "skeletonEmitters",
    ]);
    expect(sockets.every((s) => s.owner === TS_PACK)).toBe(true);
  });

  test("every pack but ts is contribution-only", () => {
    const definers = INSTALLED_PACKS.filter((p) => p.defines.length > 0).map((p) => p.name);
    expect(definers).toEqual([TS_PACK]);
  });

  test("every socket carries a description — a nameless extension point teaches nobody", () => {
    for (const socket of installedPacks().sockets) {
      expect(socket.description.length, `socket '${socket.id}'`).toBeGreaterThan(20);
    }
  });
});

// A pack whose skills nothing loads fails exactly the way a malformed
// frontmatter block does (skill-frontmatter.test.ts): silently. The skill is
// simply absent from the session, and the agent improvises the workflow from
// memory — which is how a live dogfood arm once ran its whole way through
// without its pipeline. Registration is two files that must agree, so a test
// makes them agree.
describe("a pack that ships skills is actually loaded", () => {
  const settings: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "..", "settings.json"), "utf8"));
  const packages = (settings as { packages?: string[] }).packages ?? [];

  for (const pack of INSTALLED_PACKS) {
    const dir = join(import.meta.dirname, pack.name);
    if (!existsSync(join(dir, "skills"))) continue;

    test(`${pack.name} declares its skills directory`, () => {
      const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      expect((manifest as { pi?: { skills?: string[] } }).pi?.skills).toEqual(["./skills"]);
    });

    test(`${pack.name} is in settings.json's package list`, () => {
      // pi install normalizes new local package paths without the leading
      // `./`; older registrations retain it. Both resolve to this pack.
      expect(packages.map((entry) => entry.replace(/^\.\//, ""))).toContain(`packs/${pack.name}`);
    });
  }
});

describe("composition-at-initiation is a parameter, not a rewrite", () => {
  // TN-26-005's future work, exercised today against the real packs: a project
  // that composes only ts gets the ts gates and nothing web-flavoured. If this
  // ever needs more than a second argument, the design failed.
  test("composing ts alone leaves every socket defined and empty", () => {
    const registry = composePacks(INSTALLED_PACKS, [TS_PACK]);
    expect(registry.packs).toEqual([TS_PACK]);
    expect(registry.read(lintSrcRules)).toEqual([]);
    expect(registry.read(contractPurityOverrides)).toEqual([]);
    expect(registry.read(deliverChecks)).toEqual([]);
    expect(registry.read(contractSupportFiles)).toEqual([]);
    expect(registry.read(artifactGenerators)).toEqual([]);
    expect(registry.read(skeletonEmitters)).toEqual([]);
  });

  test("the rework's stub packs compose, and contribute nothing yet", () => {
    const stubs = ["ts-hexagonal", "ts-mcp", "ts-lambda", "ts-desktop"];
    const registry = composePacks(INSTALLED_PACKS, [TS_PACK, ...stubs]);
    expect(registry.read(skeletonEmitters)).toEqual([]);
    for (const name of stubs) {
      const pack = INSTALLED_PACKS.find((p) => p.name === name);
      expect(pack?.contributes, name).toEqual([]);
      expect(pack?.defines, name).toEqual([]);
    }
    expect(() => composePacks(INSTALLED_PACKS, [TS_PACK, "ts-mcp"])).toThrow(/depends on pack 'ts-hexagonal'/);
  });

  test("the migration generator exists only where ts-drizzle-postgres is composed", () => {
    const names = (packs: readonly string[]) => composePacks(INSTALLED_PACKS, packs).read(artifactGenerators).map((g) => g.name);
    const postgres = [TS_PACK, "ts-hexagonal", TS_DRIZZLE_POSTGRES_PACK];
    expect(names([TS_PACK, "ts-service", TS_WEB_PACK])).toEqual([]);
    expect(names(postgres)).toEqual(["database-migration"]);
    // It contributes no delivery check: its check rides the project's own `check`.
    expect(composePacks(INSTALLED_PACKS, postgres).read(deliverChecks)).toEqual([]);
  });

  test("composing ts-web without ts is refused — the edge is not optional", () => {
    expect(() => composePacks(INSTALLED_PACKS, [TS_WEB_PACK])).toThrow(
      /pack 'ts-web' depends on pack 'ts'/,
    );
  });
});
