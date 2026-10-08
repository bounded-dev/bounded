import type { Clock } from "bounded/application";

/** The machine's clock. */
export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}
