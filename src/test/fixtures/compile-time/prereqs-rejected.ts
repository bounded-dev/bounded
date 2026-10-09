// Every line of code marked `// rejected: <reason>` must fail to compile with
// an error whose message contains <reason>, and no other line may fail.
import { type AgentName, contribution, corePack, definePack } from "bounded/domain";
import { type PrerequisiteRule, type PrerequisiteRuleJSON, prereqs } from "bounded/prereqs";
import { packId } from "./packs.ts";

const required = { delegate: "plan-reviewer", succeeded: true } as const;
const unchangedSince = [".agent-state/*/plan.md"] as const;
const redirect = "Have plan-reviewer review the current plan";
declare const builder: AgentName;
declare const reviewer: AgentName;

// A rule requires a delegation that succeeded: a failed one is no prerequisite.
export const failed: PrerequisiteRuleJSON = { before: { delegate: "builder" }, require: { delegate: "plan-reviewer", succeeded: false }, unchangedSince, redirect }; // rejected: Type 'false' is not assignable to type 'true'
// A rule comes before a delegation or a write; an execute is not matched yet.
export const execute: PrerequisiteRuleJSON = { before: { execute: "terraform apply" }, require: required, unchangedSince, redirect }; // rejected: 'execute' does not exist in type
// A rule comes before one action.
export const both: PrerequisiteRuleJSON = { before: { delegate: "a", write: "b" }, require: required, unchangedSince, redirect }; // rejected: Type 'string' is not assignable to type 'undefined'
// A rule names at least one file that must not change.
export const noFiles: PrerequisiteRuleJSON = { before: { delegate: "builder" }, require: required, unchangedSince: [], redirect }; // rejected: Source has 0 element(s) but target requires 1
// A rule says what to do instead.
export const noRedirect: PrerequisiteRuleJSON = { before: { delegate: "builder" }, require: required, unchangedSince }; // rejected: Property 'redirect' is missing
// What to do instead is a redirect, as in every Bounded refusal, never a fix.
export const fix: PrerequisiteRuleJSON = { before: { delegate: "builder" }, require: required, unchangedSince, fix: redirect }; // rejected: 'fix' does not exist in type
// A rule is written as its wire form; only PrerequisiteRule.parse (the point's check) makes a PrerequisiteRule.
export const literal: PrerequisiteRule = { before: { delegate: builder }, require: { delegate: reviewer, succeeded: true }, unchangedSince, redirect }; // rejected: is missing the following properties from type 'PrerequisiteRule': __brand
// Contributing rules needs prereqs in dependsOn; depending on the core pack is not enough.
export const coreOnly = definePack({ id: packId("core-only-prereqs"), dependsOn: [corePack], contributes: [contribution(prereqs.points.rules, [{ before: { delegate: "builder" }, require: required, unchangedSince, redirect }])] }); // rejected: is not assignable to type 'Contribution<NoInfer<CoreId>>'
export const noDependency = definePack({ id: packId("no-dependency-prereqs"), contributes: [contribution(prereqs.points.rules, [{ before: { delegate: "builder" }, require: required, unchangedSince, redirect }])] }); // rejected: is not assignable to type 'Contribution<never>'
