import { describe, expect, test } from "vitest";
import { EXAMPLE_PACKS, exampleContracts, exampleFacts } from "../../example-suite/example-facts.ts";
import { DOCUMENTED_CONCEPTS } from "./testdata/example-domain.ts";
import { domainEmitter } from "./domain-emitter.ts";
import { projectEmitters } from "./project-emitters.ts";

// The domain emitter runs alongside every contributed emitter, from one list.
describe("projectEmitters", () => {
  test("the domain emitter comes first, then the composed packs' emitters", () => {
    const names = projectEmitters(["ts", "ts-hexagonal"]).map((e) => e.name);
    expect(names[0]).toBe(domainEmitter.name);
    expect(names).toContain("hexagonal-domain-errors");
    expect(names).toContain("hexagonal-domain-barrel");
    expect(projectEmitters(["ts"]).map((e) => e.name)).toEqual([domainEmitter.name]);
  });

  test("on the worked example, the domain and hexagonal emitters write disjoint files", () => {
    // The example's domain contracts with their @accepts examples, which the
    // domain emitter needs to generate the laws.
    const documented = new Map(DOCUMENTED_CONCEPTS.map((c) => [c.contractPath, c.contract]));
    const contracts = exampleContracts().map((c) => ({ path: c.path, source: documented.get(c.path) ?? c.source }));
    const facts = exampleFacts({ packs: EXAMPLE_PACKS, contracts });
    const byPath = new Map<string, string>();
    for (const emitter of projectEmitters(EXAMPLE_PACKS)) {
      for (const file of emitter.emit(facts)) {
        expect(byPath.get(file.path), `${file.path}: ${emitter.name} and ${byPath.get(file.path)}`).toBeUndefined();
        byPath.set(file.path, emitter.name);
      }
    }
    // Every domain concept contract gets its skeleton and its laws from the domain emitter.
    const concepts = contracts.filter((c) => /\/src\/domain\/[^/]+\/[^/]+\.contract\.ts$/.test(c.path));
    expect(concepts.length).toBeGreaterThan(0);
    for (const { path } of concepts) {
      expect(byPath.get(path.replace(/\.contract\.ts$/, ".ts")), path).toBe(domainEmitter.name);
      expect(byPath.get(path.replace(/\.contract\.ts$/, ".laws.test.ts")), path).toBe(domainEmitter.name);
    }
    // The skeletons import the red-phase errors module ts-hexagonal generates.
    expect([...byPath.entries()].some(([p, e]) => p.endsWith("/domain/shared/errors.ts") && e === "hexagonal-domain-errors")).toBe(true);
  });
});
