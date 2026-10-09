// The legitimate forms of a project configuration. Compiles without errors.
import { type BasePack, contribution, corePack, defineConfig } from "bounded/domain";
import { base, ext, tags } from "./packs.ts";

export default defineConfig({
  packs: [corePack, base, tags],
  contributes: [contribution(base.points.words, ["project word"]), contribution(tags.points.names, ["project tag"])],
});
export const minimal = defineConfig({ packs: [corePack] });
export const listed: readonly BasePack[] = minimal.listedPacks;
// A listed pack brings in what it depends on: ext brings in base, unlisted.
export const bringsIn = defineConfig({ packs: [ext] });
