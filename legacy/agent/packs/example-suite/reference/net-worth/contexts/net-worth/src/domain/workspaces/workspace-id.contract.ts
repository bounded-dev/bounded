import type { Result } from "../shared/result.ts";

/**
 * A workspace's identity: a UUID (any version), matched case-insensitively and
 * held lower-cased. "workspace-1" and "" are refused.
 * @accepts "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f"
 * @accepts "0b7e4c2a-9d31-4f6e-a8b5-3c2d1e0f9a87"
 */
export interface WorkspaceId {
  readonly __brand: "WorkspaceId";
  readonly value: string;
  equals(other: WorkspaceId): boolean;
  toJSON(): string;
}

export interface WorkspaceIdFactory {
  generate(): WorkspaceId;
  parse(raw: unknown): Result<WorkspaceId>;
}
