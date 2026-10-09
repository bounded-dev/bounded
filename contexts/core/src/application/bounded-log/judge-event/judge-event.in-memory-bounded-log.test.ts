import { boundedLogConformance } from "./judge-event.bounded-log.test-support.ts";
import { InMemoryBoundedLog } from "./judge-event.in-memory-bounded-log.test-support.ts";

boundedLogConformance("InMemoryBoundedLog", async () => {
  const log = new InMemoryBoundedLog();
  return { log, recorded: async () => log.decisions().map((decision) => JSON.parse(JSON.stringify(decision))) };
});
