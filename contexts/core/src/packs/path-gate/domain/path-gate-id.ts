import { packIdsFor } from "bounded/domain";
import type { PathGateId } from "./path-gate-id.contract.ts";

export const pathGateId: PathGateId = packIdsFor("bounded")("path-gate");
