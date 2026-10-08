import { guardLogConformance } from "./judge-event.guard-log.test-support.ts";
import { InMemoryGuardLog } from "./judge-event.in-memory-guard-log.test-support.ts";

guardLogConformance("InMemoryGuardLog", async () => {
  const log = new InMemoryGuardLog();
  return { log, recorded: async () => log.decisions().map((decision) => JSON.parse(JSON.stringify(decision))) };
});
