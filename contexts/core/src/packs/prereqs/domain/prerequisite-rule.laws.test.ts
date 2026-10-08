import { valueObjectLaws } from "../../../domain/shared/value-object.laws.test-support.ts";
import { PrerequisiteRule } from "./prerequisite-rule.ts";

const beforeBuilder = { before: { delegate: "builder" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan" };
const beforeSrc = { before: { write: "src/**" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan before editing src/" };
valueObjectLaws(
  "PrerequisiteRule",
  PrerequisiteRule,
  [beforeBuilder, beforeSrc],
  [{ ...beforeSrc, before: { execute: "terraform apply" } }, { ...beforeSrc, require: { delegate: "plan-reviewer", succeeded: false } }, { ...beforeSrc, unchangedSince: [] }, { ...beforeBuilder, before: { delegate: "plan-reviewer" } }],
);
