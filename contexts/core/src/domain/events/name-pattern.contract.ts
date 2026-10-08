import type { Result } from "../shared/result.ts";

/** The file-name pattern a list effect is limited to, such as '*.ts': non-empty text, kept as given. */
export interface NamePattern {
  readonly __brand: "NamePattern";
  readonly value: string;
  equals(other: NamePattern): boolean;
  toJSON(): string;
}

export interface NamePatternFactory {
  /** A valid namePattern, or why the value is not one. */
  parse(raw: unknown): Result<NamePattern>;
}
