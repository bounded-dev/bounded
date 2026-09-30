// Every emitter a composed project runs (ADR 2026-060): the ts pack's own
// domain emitter first, then every composed pack's `skeletonEmitters`
// contribution in composition order. A pack does not contribute to a socket
// it defines, so the domain emitter is prepended here rather than read from
// the socket. Every consumer that writes or checks emitted files (the design
// gate's scaffold step, the red gate's shadow and delivery's generated-file
// check, wired by WI-8) takes them from this one list, so none can run the
// contributed emitters without the domain. The manifest generator reads only
// entry files, which the domain emitter never marks, so it keeps reading the
// socket alone and a design still missing @accepts examples does not stop it.

import { composePacks } from "../../../src/socket-registry.ts";
import { INSTALLED_PACKS } from "../../installed.ts";
import { type Emitter, skeletonEmitters } from "../pack.ts";
import { domainEmitter } from "./domain-emitter.ts";

export function projectEmitters(packs: readonly string[]): readonly Emitter[] {
  return [domainEmitter, ...composePacks(INSTALLED_PACKS, packs).read(skeletonEmitters)];
}
