import { z } from "zod";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./note-id.contract.ts";

const schema = z.uuid("Invalid note id");

class NoteIdImpl implements Contract.NoteId {
  declare readonly __brand: "NoteId";
  private constructor(readonly value: string) {}

  static generate(): NoteId {
    return new NoteIdImpl(crypto.randomUUID());
  }

  static parse(raw: unknown): Result<NoteId> {
    const result = schema.safeParse(raw);
    return result.success
      ? { ok: true, value: new NoteIdImpl(result.data) }
      : { ok: false, error: result.error.issues[0]?.message ?? "Invalid note id" };
  }

  equals(other: NoteId): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type NoteId = Contract.NoteId;
export const NoteId: Contract.NoteIdFactory = NoteIdImpl;
