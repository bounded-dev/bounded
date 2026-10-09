import { describe, expect, test } from "bun:test";
import * as adapters from "bounded/adapters";
import * as application from "bounded/application";
import * as domain from "bounded/domain";
import * as openProject from "bounded/open-project";
import * as protectedPathsModule from "bounded/protected-paths";
import * as protectedPathsAdaptersModule from "bounded/protected-paths/adapters";

// Everything a configuration (or a pack it imports) can reach through the
// public entry points must be frozen, so loading bounded.config.ts cannot
// patch the core: no factory, namespace, function or class prototype can be
// replaced or extended.
const ENTRY_POINTS: Record<string, Record<string, unknown>> = {
  "bounded/domain": domain,
  "bounded/application": application,
  "bounded/adapters": adapters,
  "bounded/open-project": openProject,
  "bounded/protected-paths": protectedPathsModule,
  "bounded/protected-paths/adapters": protectedPathsAdaptersModule,
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
