// Every line of code marked `// rejected: <reason>` must fail to compile with
// an error whose message contains <reason>, and no other line may fail.
// compile-time.test.ts runs the TypeScript compiler on this file and checks both.
import { type AnyPack, type Composition, contribution, definePack, type PackId, packIdsFor, point } from "bounded/domain";
import { base, ext, packId, tags, text } from "./packs.ts";

declare const somePacks: AnyPack[];
declare const either: typeof base | typeof tags;
declare const anyId: PackId;
declare const anyText: string;
const upcast: AnyPack = tags;

// 1. Only points of the pack's direct dependencies.
export const rogue = definePack({ id: packId("rogue"), contributes: [contribution(base.points.words, ["x"])] }); // rejected: is not assignable to type 'Contribution<never>'
export const emptyDeps = definePack({ id: packId("empty"), dependsOn: [], contributes: [contribution(base.points.words, ["x"])] }); // rejected: is not assignable to type 'Contribution<never>'
export const wrongEdge = definePack({ id: packId("edge"), dependsOn: [tags], contributes: [contribution(base.points.words, ["x"])] }); // rejected: Type 'PackId<"test-packs/base">' is not assignable to type 'PackId<"test-packs/tags">'
export const transitive = definePack({ id: packId("top"), dependsOn: [ext], contributes: [contribution(base.points.words, ["x"])] }); // rejected: Type 'PackId<"test-packs/base">' is not assignable to type 'PackId<"test-packs/ext">'
export const selfish = definePack({ id: packId("selfish"), dependsOn: [selfish] }); // rejected: used before its declaration
// 2. Values of exactly the point's type, nested types included; never any.
export const wrongType = contribution(base.points.words, [42]); // rejected: Type 'number' is not assignable to type 'string'
export const nestedArray = contribution(base.points.rules, [{ paths: [1], owner: { name: "x" } }]); // rejected: Type 'number' is not assignable to type 'string'
export const nestedObject = contribution(base.points.rules, [{ paths: [], owner: { name: 7 } }]); // rejected: Type 'number' is not assignable to type 'string'
export const wrongOwnValues = point({ description: "Own values", check: text, values: [1] }); // rejected: Type 'number' is not assignable to type 'string'
export const anyValues = point({ description: "Parsed", check: (raw: unknown) => ({ ok: true as const, value: JSON.parse(String(raw)) }) }); // rejected: a point's check must return a precise type, not any
export const anyArray = point({ description: "Parsed list", check: (raw: unknown) => ({ ok: true as const, value: [JSON.parse(String(raw))] }) }); // rejected: a point's check must return a precise type, not any
export const anyField = point({ description: "Parsed field", check: (raw: unknown) => ({ ok: true as const, value: { data: JSON.parse(String(raw)) } }) }); // rejected: a point's check must return a precise type, not any
// 3. dependsOn is a tuple of distinct packs, each with an exact id.
export const notTuple = definePack({ id: packId("list"), dependsOn: somePacks }); // rejected: list dependsOn as a tuple of packs
export const unionDep = definePack({ id: packId("union"), dependsOn: [either], contributes: [contribution(base.points.words, ["x"])] }); // rejected: each dependency is a pack with an exact id
export const upcastDep = definePack({ id: packId("upcast"), dependsOn: [upcast], contributes: [contribution(base.points.words, ["x"])] }); // rejected: each dependency is a pack with an exact id
export const castDep = definePack({ id: packId("cast"), dependsOn: [tags as AnyPack], contributes: [contribution(base.points.words, ["x"])] }); // rejected: each dependency is a pack with an exact id
export const twice = definePack({ id: packId("twice"), dependsOn: [base, base] }); // rejected: list each dependency once
export const typeArgs = definePack<PackId<"test-packs/args">, Record<never, never>, [typeof base]>({ id: packId("args"), contributes: [contribution(base.points.words, ["x"])] }); // rejected: Property 'dependsOn' is missing
// 4. Points are declared only inside their own pack, under camelCase keys, each with a check.
export const thief = definePack({ id: packId("thief"), points: { stolen: base.points.words } }); // rejected: is not assignable to type 'AnyDeclaration'
export const dotted = definePack({ id: packId("dotted"), points: { "a.b": point({ description: "Dotted", check: text }) } }); // rejected: point keys are camelCase words
export const proto = definePack({ id: packId("proto"), points: { ["__proto__"]: point({ description: "Prototype", check: text }) } }); // rejected: point keys are camelCase words
export const capital = definePack({ id: packId("capital"), points: { Words: point({ description: "Capital", check: text }) } }); // rejected: point keys are camelCase words
export const unchecked = point({ description: "No check" }); // rejected: Property 'check' is missing
// 5. Ids: exact, branded, from one factory per npm package.
export const widenedId = definePack({ id: anyId }); // rejected: give the pack an exact id from packIdsFor
export const plainId = definePack({ id: "test-packs/plain" }); // rejected: Type 'string' is not assignable to type '{ readonly __packId: string; }'
export const widenedPackage = packIdsFor(anyText); // rejected: write the npm package name as a string literal
export const upperPackage = packIdsFor("Acme"); // rejected: npm package names are lowercase
export const deepPackage = packIdsFor("acme/rules"); // rejected: an npm package name is name or @scope/name
export const slashLocal = packId("a/b"); // rejected: a pack's local id is lowercase words joined by hyphens, without '/'
export const leadingHyphen = packId("-a"); // rejected: a pack's local id is lowercase words joined by hyphens, without '/'
export const doubleHyphen = packId("a--b"); // rejected: a pack's local id is lowercase words joined by hyphens, without '/'
export const leadingDigit = packId("1a"); // rejected: a pack's local id is lowercase words joined by hyphens, without '/'
export const widenedLocal = packId(anyText); // rejected: write the pack's local id as a string literal
// 6. Reads are typed by the point object.
export function read(composition: Composition): readonly number[] {
  const words = composition.read(base.points.words);
  return words.ok ? words.value : []; // rejected: Type 'string' is not assignable to type 'number'
}
