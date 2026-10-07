// Every line marked `// rejected: <reason>` must fail to compile with an error
// whose message contains <reason>, and no other line may fail.
// compile-time.test.ts runs the TypeScript compiler on this file and checks both.
import { Contribution, ExtensionPoint, Pack } from "@bounded/core/domain";
import { tags, words } from "./points.ts";

declare const anyName: string;
declare const oneOf: "rogue" | "base";
declare const pattern: `b${string}`;

// Contributing to a point whose owner is not a declared dependency.
export const rogue = new Pack({ name: "rogue", contributes: [new Contribution(words, ["x"])] }); // rejected: '"base"' is not assignable
export const wrongEdge = new Pack({ name: "ext", dependsOn: ["tags"], contributes: [new Contribution(words, ["x"])] }); // rejected: '"base"' is not assignable
// A dependency of a dependency is not enough: "ext" depends on "base", "top" only on "ext".
export const top = new Pack({ name: "top", dependsOn: ["ext"], contributes: [new Contribution(words, ["x"])] }); // rejected: '"base"' is not assignable
// Declaring a point another pack owns.
export const thief = new Pack({ name: "thief", declares: [tags] }); // rejected: '"tags"' is not assignable to type '"thief"'
// A value of the wrong type for the point.
export const wrongType = new Contribution(words, [42]); // rejected: 'number' is not assignable to type 'string'
// Names the compiler cannot pin to one literal would switch the check off.
export const widened = new Pack({ name: anyName }); // rejected: write pack names as single string literals
export const union = new Pack({ name: oneOf, contributes: [new Contribution(words, ["x"])] }); // rejected: write pack names as single string literals
export const templated = new Pack({ name: pattern }); // rejected: write pack names as single string literals
export const widenedDeps = new Pack({ name: "ext", dependsOn: [anyName] }); // rejected: write pack names as single string literals
export const unionDeps = new Pack({ name: "ext", dependsOn: [oneOf], contributes: [new Contribution(words, ["x"])] }); // rejected: write pack names as single string literals
export const widenedOwner = ExtensionPoint.ownedBy(anyName); // rejected: write pack names as single string literals
export const unionOwner = ExtensionPoint.ownedBy(oneOf); // rejected: write pack names as single string literals
// Dependencies come only from dependsOn: naming them as type arguments is not enough.
export const typeArgs = new Pack<"rogue", ["base"]>({ name: "rogue", contributes: [new Contribution(words, ["x"])] }); // rejected: 'dependsOn' is missing
export const multiLine = new Pack({
  name: "multi",
  contributes: [new Contribution(words, ["x"])], // rejected: '"base"' is not assignable
});
