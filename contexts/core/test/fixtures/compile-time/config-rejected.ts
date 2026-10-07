// Every line of code marked `// rejected: <reason>` must fail to compile with
// an error whose message contains <reason>, and no other line may fail.
import { type AnyPack, contribution, corePack, defineConfig } from "bounded/domain";
import { base, tags } from "./packs.ts";

declare const somePacks: AnyPack[];

// The project contributes only to points of packs it selects.
export const unselected = defineConfig({ packs: [corePack, tags], contributes: [contribution(base.points.words, ["x"])] }); // rejected: Type 'PackId<"test-packs/base">' is not assignable to type
export const none = defineConfig({ packs: [corePack], contributes: [contribution(base.points.words, ["x"])] }); // rejected: is not assignable to type
// The selection is a tuple of distinct packs.
export const widened = defineConfig({ packs: somePacks }); // rejected: list packs as a tuple of packs
export const twice = defineConfig({ packs: [corePack, corePack] }); // rejected: list each pack once
export const loose = defineConfig({ packs: [corePack, tags as AnyPack] }); // rejected: each selected pack is a pack with an exact id
// Values have exactly the point's type.
export const wrongType = defineConfig({ packs: [corePack, base], contributes: [contribution(base.points.words, [42])] }); // rejected: Type 'number' is not assignable to type 'string'
