// The wire forms of a prerequisite rule that the pack's own tests expect
// PrerequisiteRule.parse to accept, copied verbatim from
// prerequisite-rule.test.ts and prerequisite-rule.laws.test.ts. The package
// catalogue's schema for the rules point must accept each of them
// (src/core/composition-root/pack-wire-schemas.test.ts). They are copies: a
// later change should make the concept tests consume this list (ADR 2026-026).
const beforeBuilder = { before: { delegate: "builder" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan" };
const beforeSrc = { before: { write: "src/**" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan before editing src/" };
const beforeTests = { before: { delegate: "test-writer" }, require: { delegate: "spec-reviewer", succeeded: true }, unchangedSince: ["spec.md", "src/**/*.contract.ts"], redirect: "Have spec-reviewer review the current spec and contracts" };
const beforeApply = { before: { execute: "terraform apply" }, require: { delegate: "infra-reviewer", succeeded: true }, unchangedSince: ["infra/**"], redirect: "Have infra-reviewer review the current infra/ changes" };

/** Every wire form of a prerequisite rule the concept tests accept. */
export const prerequisiteRuleWireForms: readonly unknown[] = [
  beforeBuilder,
  beforeSrc,
  beforeTests,
  beforeApply,
  { ...beforeSrc, unchangedSince: ["./.agent-state//*/plan.md"], redirect: " Review it " },
  { ...beforeSrc, before: { execute: "terraform apply" } },
  { ...beforeSrc, redirect: "x".repeat(1000) },
];
