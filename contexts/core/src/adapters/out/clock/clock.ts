import type { Clock } from "bounded/application";
import { DecisionTime } from "bounded/domain";

/** The machine's clock: the time as a DecisionTime. */
export class SystemClock implements Clock {
  now(): DecisionTime {
    // toISOString always gives a DecisionTime; a failure would throw inside the handlers' recording, a failure to record (fail closed).
    const time = DecisionTime.parse(new Date().toISOString());
    if (!time.ok) throw new Error(time.error);
    return time.value;
  }
}
