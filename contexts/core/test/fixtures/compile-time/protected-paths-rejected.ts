// Every line of code marked `// rejected: <reason>` must fail to compile with
// an error whose message contains <reason>, and no other line may fail.
import { contribution, corePack, defineConfig, definePack } from "bounded/domain";
import { protectedPathsPack, type ProtectedPath, type ProtectedPathJSON } from "bounded/protected-paths";
import type { WatchedPath } from "bounded/protected-paths";
// There is no shorthand for every write: deny lists name each kind.
import { writes } from "bounded/protected-paths"; // rejected: has no exported member 'writes'
export const spread = writes;
import { packId } from "./packs.ts";

const redirect = "Do something else";

// A rule denies read, list, create, modify or delete: each write is named.
export const unknownKind: ProtectedPathJSON = { match: "a/**", deny: ["write"], redirect }; // rejected: Type '"write"' is not assignable to type 'PathAccess'
// A rule denies at least one thing.
export const denyNothing: ProtectedPathJSON = { match: "a/**", deny: [], redirect }; // rejected: Source has 0 element(s) but target requires 1
// A rule says what to do instead.
export const noRedirect: ProtectedPathJSON = { match: "a/**", deny: ["read"] }; // rejected: Property 'redirect' is missing
// A rule's except is a list of patterns.
export const exceptText: ProtectedPathJSON = { match: "a/**", except: "a/b/**", deny: ["read"], redirect }; // rejected: Type 'string' is not assignable to type 'readonly string[]'
// A rule is written as its wire form; only ProtectedPath.parse (the point's check) makes a ProtectedPath.
export const literalRule: ProtectedPath = { match: "a/**", except: [], deny: ["read"], redirect }; // rejected: is missing the following properties from type 'ProtectedPath': __brand
// A rule contributed as a literal is checked as one.
export const badLiteral = definePack({ id: packId("bad-literal"), dependsOn: [protectedPathsPack], contributes: [contribution(protectedPathsPack.points.protectedPaths, [{ match: "a/**", deny: ["write"], redirect }])] }); // rejected: Type '"write"' is not assignable to type 'PathAccess'
// Contributing rules needs protectedPathsPack in dependsOn; depending on the core pack is not enough.
export const coreOnly = definePack({ id: packId("core-only"), dependsOn: [corePack], contributes: [contribution(protectedPathsPack.points.protectedPaths, [{ match: "a/**", deny: ["read"], redirect }])] }); // rejected: is not assignable to type 'Contribution<NoInfer<CoreId>>'
export const noDependency = definePack({ id: packId("no-dependency"), contributes: [contribution(protectedPathsPack.points.protectedPaths, [{ match: "a/**", deny: ["read"], redirect }])] }); // rejected: is not assignable to type 'Contribution<never>'
export const watched: WatchedPath = { match: "a/**", except: [], why: "w", redirect: "r" }; // rejected: is missing the following properties from type 'WatchedPath': __brand
// A project contributes to the core's points only when it lists corePack, even though the protected-paths pack brings it in.
export const coreBroughtIn = defineConfig({ packs: [protectedPathsPack], contributes: [contribution(corePack.points.effectGuards.write, [])] }); // rejected: is not assignable to type
