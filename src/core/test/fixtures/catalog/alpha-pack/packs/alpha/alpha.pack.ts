import { corePack, definePack } from "bounded/domain";
import type { AlphaPack } from "./alpha.contract.ts";
import { alphaId } from "./domain/alpha-id.ts";

/** The second demonstration pack, `demo-package/alpha`: it only depends on the core. */
export const alphaPack: AlphaPack = definePack({
  id: alphaId,
  dependsOn: [corePack],
});
