// The refusing pack, `refusing-package/refusing`: it refuses every write and
// allows everything else. It needs no ports. A fixture for the example
// scenarios runner's tests (ADR 2026-031), installed into a scenario's
// project as a link. Its refusals start, as every pack's do, with
// "refusing-package/refusing refused <the write>".
import { contribution, corePack, definePack, packIdsFor, Verdict } from "bounded/domain";

export const refusingPack = definePack({
  id: packIdsFor("refusing-package")("refusing"),
  dependsOn: [corePack],
  contributes: [contribution(corePack.points.effectGuards.write, [() => Verdict.refuse("this pack refuses every write", "Write nothing here")])],
});
