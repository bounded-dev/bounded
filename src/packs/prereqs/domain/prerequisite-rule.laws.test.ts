import { valueObjectLaws } from "../../../core/domain/shared/value-object.laws.test-support.ts";
import { PrerequisiteRule } from "./prerequisite-rule.ts";

const beforeBuilder = { before: { delegate: "builder" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan" };
const beforeSrc = { before: { write: "src/**" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan before editing src/" };
const beforeApply = { before: { execute: "terraform apply" }, require: { delegate: "infra-reviewer", succeeded: true }, unchangedSince: ["infra/**"], redirect: "Have infra-reviewer review the current infra/ changes" };
valueObjectLaws(
  "PrerequisiteRule",
  PrerequisiteRule,
  [beforeBuilder, beforeSrc, beforeApply],
  [
    { ...beforeSrc, before: { execute: "terraform apply", write: "src/**" } },
    { ...beforeSrc, before: { execute: "terraform -auto-approve" } },
    { ...beforeSrc, require: { delegate: "plan-reviewer", succeeded: false } },
    { ...beforeSrc, unchangedSince: [] },
    { ...beforeBuilder, before: { delegate: "plan-reviewer" } },
  ],
);
