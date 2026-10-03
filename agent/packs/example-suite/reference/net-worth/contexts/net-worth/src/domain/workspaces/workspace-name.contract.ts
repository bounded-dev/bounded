import type { Result } from "../shared/result.ts";

/**
 * The name of a workspace: a string that, once trimmed, is 1 to 80 characters
 * long. The value is the trimmed string.
 * @accepts "Smith household"
 * @accepts "Family finances"
 */
export interface WorkspaceName {
  readonly __brand: "WorkspaceName";
  readonly value: string;
  equals(other: WorkspaceName): boolean;
  toJSON(): string;
}

export interface WorkspaceNameFactory {
  parse(raw: unknown): Result<WorkspaceName>;
}
