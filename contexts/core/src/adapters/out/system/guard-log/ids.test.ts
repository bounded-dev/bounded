import { decisionIdsConformance } from "../../../../application/guard-log/judge-event/judge-event.ids.test-support.ts";
import { RandomDecisionIds } from "./ids.ts";

decisionIdsConformance("RandomDecisionIds", () => new RandomDecisionIds());
