import { Event, type Result } from "bounded/domain";
import type * as Contract from "./judge-event.contract.ts";

class JudgeEventCommandImpl implements Contract.JudgeEventCommand {
  declare readonly __brand: "JudgeEventCommand";
  private constructor(readonly event: Event) {}

  static parse(raw: unknown): Result<JudgeEventCommand> {
    const event = Event.parse(raw);
    return event.ok ? { ok: true, value: new JudgeEventCommandImpl(event.value) } : event;
  }
}

export type JudgeEventCommand = Contract.JudgeEventCommand;
export const JudgeEventCommand: Contract.JudgeEventCommandFactory = JudgeEventCommandImpl;
