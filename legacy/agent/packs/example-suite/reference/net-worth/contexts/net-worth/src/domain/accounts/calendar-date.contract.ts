import type { Result } from "../shared/result.ts";

/**
 * A day in the Gregorian calendar, with no time and no time zone. Parsing takes
 * a string, trims it, and accepts it only if it is exactly "YYYY-MM-DD" (four,
 * two and two ASCII digits) naming a real date: year 1000 to 9999, month 01 to
 * 12, day within that month (29 February only in leap years: divisible by 4,
 * except centuries not divisible by 400). "2024-02-30", "2023-02-29",
 * "2024-1-05" and "05/01/2024" are refused. The value is the "YYYY-MM-DD"
 * string, so plain string comparison orders dates.
 * @accepts "2024-01-31"
 * @accepts "2020-02-29"
 */
export interface CalendarDate {
  readonly __brand: "CalendarDate";
  readonly value: string;
  equals(other: CalendarDate): boolean;
  toJSON(): string;
  /** Whether this day is strictly earlier than the other. */
  isBefore(other: CalendarDate): boolean;
}

export interface CalendarDateFactory {
  parse(raw: unknown): Result<CalendarDate>;
}
