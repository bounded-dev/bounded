import { describe, expect, test } from "bun:test";
import * as fileSystem from "bounded/adapters/file-system";
import * as inMemory from "bounded/adapters/in-memory";
import * as system from "bounded/adapters/system";
import * as application from "bounded/application";
import * as domain from "bounded/domain";
import * as openProject from "bounded/open-project";

// Everything a configuration (or a pack it imports) can reach through the
// public entry points must be frozen, so loading bounded.config.ts cannot
// patch the core: no factory, namespace, function or class prototype can be
// replaced or extended.
const ENTRY_POINTS: Record<string, Record<string, unknown>> = {
  "bounded/domain": domain,
  "bounded/application": application,
  "bounded/adapters/in-memory": inMemory,
  "bounded/adapters/file-system": fileSystem,
  "bounded/adapters/system": system,
  "bounded/open-project": openProject,
};

function unfrozen(name: string, value: unknown): string[] {
  if (typeof value === "function") {
    const prototype = (value as { prototype?: unknown }).prototype;
    return [
      ...(Object.isFrozen(value) ? [] : [`${name} is not frozen`]),
      ...(prototype === undefined || Object.isFrozen(prototype) ? [] : [`${name}.prototype is not frozen`]),
    ];
  }
  return typeof value === "object" && value !== null && !Object.isFrozen(value) ? [`${name} is not frozen`] : [];
}

describe("the public API is frozen", () => {
  for (const [entry, module] of Object.entries(ENTRY_POINTS)) {
    test(`every export of ${entry}`, () => {
      expect(Object.entries(module).flatMap(([name, value]) => unfrozen(`${entry} ${name}`, value))).toEqual([]);
    });
  }

  test("assigning to a frozen factory throws, and changes nothing", () => {
    const { Verdict } = domain;
    const parse = Verdict.parse;
    expect(() => {
      (Verdict as unknown as { parse: unknown }).parse = () => ({ ok: true, value: Verdict.allow });
    }).toThrow();
    expect(Verdict.parse).toBe(parse);
  });
});
