// Test obligations (ADR LEG-2026-063, TN-26-012 §8): did the suite discharge what
// it owes at every level of the design, or merely go red?
//
// The red gate proves the suite fails for the right REASON. It says nothing
// about COVERAGE of the design, and dogfood Run 7 paid for the gap: a valid red
// and a clean green over a suite that never called 9 of 15 exports. So the
// gates also ask, per level:
//
//   domain    every concept has its generated laws and a hand-written unit
//             test file, and every factory member (`parse`, `generate`,
//             `new`) and instance method is reached by some test
//   boundaries every value object and identifier has a "<Name> — boundaries"
//             block over its `Result` (boundaries.ts)
//   (packs)   the layout pack's levels, through the `testObligations` socket:
//             ts-hexagonal's features, stores, out adapters, in-adapter laws
//             and app smoke tests
//
// REACHED means called: a call site in a test (`Note.parse(…)`, `new Note(…)`,
// `x.equals(…)`), or a red failure that named the member
// (`NotImplementedError: Not implemented: Note.equals`). Call sites are the
// primary evidence: a member whose inputs come from another member can never
// surface in a red failure, because every test dies at the first skeleton
// call (Run 9). This eliminates OMISSION, not evasion: one lazy call
// satisfies it. It is a forcing function for attention, not a coverage proof.
//
// Everything here is pure over an `ObligationInput` except `readObligationInput`,
// the thin disk reader.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { callSites, sourcesAt } from "./call-sites.ts";
import { expandSourceRoots } from "../../../src/path-gate.ts";
import { generatedFileGlobs, hasTestFileSuffix, pathGlobMatcher, sourceRoots, testFileSuffixes } from "../../../src/pack-contrib.ts";
import { composePacks } from "../../../src/socket-registry.ts";
import { INSTALLED_PACKS } from "../../installed.ts";
import {
  type ObligationGap,
  type ObligationInput,
  type ObligationSource,
  type ProjectFacts,
  type TestObligation,
  type TestPhase,
  testObligations,
} from "../pack.ts";
import { boundariesObligation } from "./boundaries.ts";
import { isDomainConceptPath, lawsPathOf, parseDomainConcept } from "./domain-concept.ts";

// =================================================================================
// Reached names
// =================================================================================

// The error line a red failure carries: `NotImplementedError: Not implemented:
// <Class>.<member>` (the generated errors module), in any of the forms a
// runner prints it. Anchored to a line start so prose cannot fabricate one.
const NOT_IMPLEMENTED_LINE = /(?:^|\n)[ \t]*(?:NotImplementedError[ \t]*:[ \t]*)?Not[ \t]?implemented[ \t]*:[ \t]*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$#][\w$]*)*)[ \t]*(?:\n|$)/i;

/** The `<Class>.<member>` a red failure message names, if it names one. */
export function reachedName(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  const match = NOT_IMPLEMENTED_LINE.exec(message);
  return match?.[1];
}

/** Every distinct name reached across a run's failure messages, sorted. */
export function reachedNames(messages: Iterable<string | undefined>): string[] {
  const names = new Set<string>();
  for (const message of messages) {
    const name = reachedName(message);
    if (name !== undefined) names.add(name);
  }
  return [...names].sort();
}

// Call sites live in call-sites.ts, which imports no pack registry, so the
// layout pack's obligations can use them without an import cycle.
export { callSites, sourcesAt, type CallSites } from "./call-sites.ts";

// =================================================================================
// The ts pack's own level: domain concepts
// =================================================================================

/** The domain level (TN-26-012 §8): laws and a unit test file per concept, and
 *  every factory member and instance method reached. */
export const domainObligation: TestObligation = {
  name: "domain-concepts",
  description: "Every domain concept has its generated laws and a unit test file, and its tests reach every factory member and instance method.",
  check(input: ObligationInput): ObligationGap[] {
    const gaps: ObligationGap[] = [];
    const files = new Set(input.files);
    const all = [...input.tests, ...input.generatedTests];
    const sites = callSites(all);
    for (const workspace of input.facts.workspaces) {
      for (const contract of workspace.contracts) {
        if (!isDomainConceptPath(contract.path)) continue;
        const model = parseDomainConcept(contract.path, contract.source);
        const laws = lawsPathOf(contract.path);
        if (!files.has(laws)) {
          gaps.push({ level: "domain", path: laws, message: `${model.name} has no generated laws; run the design gate, which writes them` });
        }
        const unit = contract.path.replace(/\.contract\.ts$/, ".test.ts");
        if (!input.tests.some((t) => t.path === unit)) {
          gaps.push({ level: "domain", path: unit, message: `${model.name} has no unit test file; write ${unit} for the rules its laws cannot know` });
        }
        const reached = (member: string): boolean => input.reached.has(`${model.name}.${member}`);
        for (const member of model.factoryMembers) {
          if (member.kind === "construct") {
            if (!sites.constructed.has(model.name) && !reached("constructor")) {
              gaps.push({ level: "domain", path: unit, message: `no test constructs ${model.name}: call new ${model.name}(…)` });
            }
          } else if (!sites.qualified.has(`${model.name}.${member.name}`) && !reached(member.name)) {
            gaps.push({ level: "domain", path: unit, message: `no test calls ${model.name}.${member.name}(…)` });
          }
        }
        const own = callSites(sourcesAt(all, [unit, laws]));
        for (const method of model.instanceMethods) {
          if (!own.methods.has(method.name) && !reached(method.name)) {
            gaps.push({ level: "domain", path: unit, message: `no test of ${model.name} calls its ${method.name}(…)` });
          }
        }
      }
    }
    return gaps;
  },
};

/** Every obligation a composed project checks: the domain first, then every
 *  composed pack's contribution in composition order. */
export function projectObligations(packs: readonly string[]): readonly TestObligation[] {
  return [domainObligation, boundariesObligation, ...composePacks(INSTALLED_PACKS, packs).read(testObligations)];
}

/** Run every obligation; a check that throws is a gap naming it, because a
 *  check that crashed verified nothing. */
export function checkObligations(input: ObligationInput): ObligationGap[] {
  const gaps: ObligationGap[] = [];
  for (const obligation of projectObligations(input.facts.packs)) {
    if (!(obligation.phases ?? ["red"]).includes(input.phase)) continue;
    try {
      gaps.push(...obligation.check(input));
    } catch (error) {
      gaps.push({ level: obligation.name, message: `the '${obligation.name}' check could not read the design: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return gaps;
}

/** The test-writer's remedy, one line per gap. */
export function obligationLines(gaps: readonly ObligationGap[]): string[] {
  return gaps.map((g) => `  ${g.level}: ${g.message}${g.path !== undefined && !g.message.includes(g.path) ? ` (${g.path})` : ""}`);
}

// =================================================================================
// IO
// =================================================================================

/** Every file under the composed source roots, project-relative, sorted.
 *  Dependency and dot directories are skipped. */
export function sourceRootFiles(cwd: string, roots: readonly string[] = sourceRoots(cwd)): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(cwd, full).split(sep).join("/"));
    }
  };
  for (const root of expandSourceRoots(cwd, roots)) walk(join(cwd, root));
  return out.sort();
}

/** The disk half of an obligation check. */
export function readObligationInput(
  cwd: string,
  facts: ProjectFacts,
  phase: TestPhase,
  reached: Iterable<string> = [],
): ObligationInput {
  const files = sourceRootFiles(cwd);
  const suffixes = testFileSuffixes(cwd);
  const isGenerated = pathGlobMatcher(generatedFileGlobs(cwd));
  const tests: ObligationSource[] = [];
  const generatedTests: ObligationSource[] = [];
  for (const path of files) {
    if (!hasTestFileSuffix(path, suffixes) || !/\.tsx?$/.test(path)) continue;
    const source = { path, source: readFileSync(join(cwd, path), "utf8") };
    (isGenerated(path) ? generatedTests : tests).push(source);
  }
  return { facts, phase, files, tests, generatedTests, reached: new Set(reached) };
}
