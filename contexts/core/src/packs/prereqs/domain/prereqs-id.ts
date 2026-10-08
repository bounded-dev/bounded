import { packIdsFor } from "bounded/domain";
import type { PrereqsId } from "./prereqs-id.contract.ts";

export const prereqsId: PrereqsId = packIdsFor("bounded")("prereqs");
