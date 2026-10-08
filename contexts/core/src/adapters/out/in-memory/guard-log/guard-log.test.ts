import { guardLogConformance } from "../../../../application/guard-log/judge-event/judge-event.guard-log.test-support.ts";
import { InMemoryGuardLog } from "./guard-log.ts";

guardLogConformance("InMemoryGuardLog", async () => {
  const log = new InMemoryGuardLog();
  return { log, recorded: async () => log.decisions().map((decision) => JSON.parse(JSON.stringify(decision))) };
});
