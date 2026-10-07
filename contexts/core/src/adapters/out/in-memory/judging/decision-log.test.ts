import { decisionLogConformance } from "../../../../application/judging/judge-event/judge-event.decision-log.test-support.ts";
import { InMemoryDecisionLog } from "./decision-log.ts";

decisionLogConformance("InMemoryDecisionLog", async () => {
  const log = new InMemoryDecisionLog();
  return { log, recorded: async () => log.decisions() };
});
