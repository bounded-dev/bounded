import { clockConformance } from "../../../../application/guard-log/judge-event/judge-event.clock.test-support.ts";
import { SystemClock } from "./clock.ts";

clockConformance("SystemClock", () => new SystemClock());
