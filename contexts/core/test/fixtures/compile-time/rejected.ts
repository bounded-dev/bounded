// Every line marked `rejected` must fail to compile, and no other line may.
// compile-time.test.ts runs the TypeScript compiler on this file and checks both.
import { Contribution, ExtensionPoint, Pack } from "@bounded/core/domain";

const words = ExtensionPoint.ownedBy("base").declare<string>({ id: "base.words", description: "Words" });
const other = ExtensionPoint.ownedBy("other").declare<string>({ id: "other.items", description: "Items" });
const anyName: string = "base";

// Contributing to a point whose owner is not a declared dependency.
export const rogue = new Pack({ name: "rogue", contributes: [new Contribution(words, ["x"])] }); // rejected
export const wrongEdge = new Pack({ name: "ext", dependsOn: ["other"], contributes: [new Contribution(words, ["x"])] }); // rejected
// Declaring a point another pack owns.
export const thief = new Pack({ name: "thief", declares: [other] }); // rejected
// A value of the wrong type for the point.
export const wrongType = new Contribution(words, [42]); // rejected
// A pack name or owner the compiler cannot see as a literal would defeat the check.
export const widened = new Pack({ name: anyName }); // rejected
export const widenedOwner = ExtensionPoint.ownedBy(anyName); // rejected
export const widenedDeps = new Pack({ name: "ext", dependsOn: [anyName] }); // rejected
