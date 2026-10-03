import type { Result } from "../shared/result.ts";
import type { CalendarDate } from "./calendar-date.contract.ts";

/**
 * The day an account closes, or none while it is open. Parsing takes a string
 * and trims it: the empty string means "open"; anything else must parse as a
 * CalendarDate (same rules). The value is "" or the "YYYY-MM-DD" string.
 * @accepts "2025-06-30"
 * @accepts "2019-12-31"
 */
export interface EndDate {
  readonly __brand: "EndDate";
  readonly value: string;
  equals(other: EndDate): boolean;
  toJSON(): string;
  /** Whether no end date is set (the value is ""). */
  isOpen(): boolean;
  /** Whether an end date is set and it is strictly earlier than the date. */
  isBefore(date: CalendarDate): boolean;
  /** Whether an end date is set and it is on or before the date: the account is closed on that date. */
  closesBy(date: CalendarDate): boolean;
}

export interface EndDateFactory {
  parse(raw: unknown): Result<EndDate>;
}
