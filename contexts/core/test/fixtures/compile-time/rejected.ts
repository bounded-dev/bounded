// Every line of code marked `// rejected: <reason>` must fail to compile with
// an error whose message contains <reason>, and no other line may fail.
// compile-time.test.ts runs the TypeScript compiler on this file and checks both.
import { type AnyPack, type Composition, contribution, definePack, point, type Result } from "@bounded/core/domain";
import { base, ext, tags } from "./packs.ts";

declare const somePacks: AnyPack[];
declare const either: typeof base | typeof tags;
declare const anyLabel: string;
const text = (raw: unknown): Result<string> => (typeof raw === "string" ? { ok: true, value: raw } : { ok: false, error: "not text" });

// 1. Only points of the pack's direct dependencies.
export const rogue = definePack({ id: "rogue", contributes: [contribution(base.points.words, ["x"])] }); // rejected: is not assignable to type 'Contribution<never>'
export const emptyDeps = definePack({ id: "empty", dependsOn: [], contributes: [contribution(base.points.words, ["x"])] }); // rejected: is not assignable to type 'Contribution<never>'
export const wrongEdge = definePack({ id: "edge", dependsOn: [tags], contributes: [contribution(base.points.words, ["x"])] }); // rejected: Type '"base"' is not assignable to type '"tags"'
export const transitive = definePack({ id: "top", dependsOn: [ext], contributes: [contribution(base.points.words, ["x"])] }); // rejected: Type '"base"' is not assignable to type '"ext"'
export const impostor = definePack({ id: "base", points: { words: point({ description: "Same label, other pack", check: (raw: unknown): Result<number> => ({ ok: true, value: Number(raw) }) }) } });
export const viaImpostor = definePack({ id: "fooled", dependsOn: [impostor], contributes: [contribution(base.points.words, ["x"])] }); // rejected: is not assignable to type
export const selfish = definePack({ id: "selfish", dependsOn: [selfish] }); // rejected: used before its declaration
// 2. Values of exactly the point's type, nested types included.
export const wrongType = contribution(base.points.words, [42]); // rejected: 'number' is not assignable to type 'string'
export const nestedArray = contribution(base.points.rules, [{ paths: [1], owner: { name: "x" } }]); // rejected: 'number' is not assignable to type 'string'
export const nestedObject = contribution(base.points.rules, [{ paths: [], owner: { name: 7 } }]); // rejected: 'number' is not assignable to type 'string'
export const wrongOwnValues = point({ description: "Own values", check: text, values: [1] }); // rejected: 'number' is not assignable to type 'string'
// 3. dependsOn is a tuple of distinct pack objects, never widened.
export const notTuple = definePack({ id: "list", dependsOn: somePacks }); // rejected: list dependsOn as a tuple of packs
export const unionDep = definePack({ id: "union", dependsOn: [either], contributes: [contribution(base.points.words, ["x"])] }); // rejected: each dependency is one pack
export const twice = definePack({ id: "twice", dependsOn: [base, base] }); // rejected: list each dependency once
export const typeArgs = definePack<"args", Record<never, never>, [typeof base]>({ id: "args", contributes: [contribution(base.points.words, ["x"])] }); // rejected: 'dependsOn' is missing
// 4. Points are declared only inside their own pack, under valid keys; labels are literals.
export const thief = definePack({ id: "thief", points: { stolen: base.points.words } }); // rejected: is not assignable to type 'PointDeclaration
export const dotted = definePack({ id: "dotted", points: { "a.b": point({ description: "Dotted", check: text }) } }); // rejected: point keys are camelCase words without dots
export const widened = definePack({ id: anyLabel }); // rejected: write the pack id as a string literal
export const unchecked = point({ description: "No check" }); // rejected: 'check' is missing
// 6. Reads are typed by the point object.
export function read(composition: Composition): readonly number[] {
  const words = composition.read(base.points.words);
  return words.ok ? words.value : []; // rejected: 'string' is not assignable to type 'number'
}
