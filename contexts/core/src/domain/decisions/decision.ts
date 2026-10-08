import type { AdapterRefusal } from "./adapter-refusal.contract.ts";
import { describeEffect } from "../events/effect.ts";
import type { Event } from "../events/event.contract.ts";
import type { ToolResult } from "../events/tool-result.contract.ts";
import type { ToolKind } from "../events/tool-use.contract.ts";
import { TOOL_KINDS } from "../events/tool-use.ts";
import type { Judgement } from "../guards/dispatch-event.contract.ts";
import { own, readSafely } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { sameWire, wireFormOf } from "../shared/wire.ts";
import type { Verdict } from "../verdicts/verdict.contract.ts";
import type * as Contract from "./decision.contract.ts";
import type { DecisionId as DecisionIdType } from "./decision-id.contract.ts";
import { DecisionId } from "./decision-id.ts";

/** The longest text field a decision keeps. */
const LIMIT = 4096;
/** Text of at most LIMIT characters, counted and cut in code points so a character is never split. */
function bounded(text: string): string {
  const characters = [...text];
  return characters.length <= LIMIT ? text : `${characters.slice(0, LIMIT).join("")}… (shortened from ${characters.length} characters)`;
}

function verdictOf(verdict: Verdict, refusedBy: Judgement["refusedBy"]): Contract.RecordedVerdict {
  if (verdict.kind === "allow") return Object.freeze({ kind: "allow" });
  return Object.freeze({
    kind: "refuse",
    reason: bounded(verdict.reason),
    redirect: bounded(verdict.redirect),
    pack: refusedBy === null ? null : refusedBy.packId.value,
    effect: refusedBy === null || refusedBy.effect === null ? null : bounded(describeEffect(refusedBy.effect)),
  });
}

/** The host's input as JSON text, bounded; text for an input that cannot be shown. */
function summary(input: unknown): string {
  try {
    const text = JSON.stringify(input);
    return bounded(text === undefined ? String(input) : text);
  } catch {
    return "an input that cannot be shown";
  }
}

/** A decision's fields, its id checked. */
type Fields = Omit<Contract.DecisionJSON, "id"> & { readonly id: DecisionIdType };

class DecisionImpl implements Contract.Decision {
  declare readonly __brand: "Decision";
  readonly #made = true;
  readonly id: DecisionIdType;
  readonly time: string;
  readonly event: Contract.DecisionEvent;
  readonly role: string | null;
  readonly tool: ToolKind | null;
  readonly effects: readonly string[];
  readonly verdict: Contract.RecordedVerdict;
  readonly note: string | null;
  declare readonly host?: { readonly tool: string; readonly input: string };

  private constructor(fields: Fields) {
    this.id = fields.id;
    this.time = bounded(fields.time);
    this.event = fields.event;
    this.role = fields.role;
    this.tool = fields.tool;
    this.effects = Object.freeze([...fields.effects]);
    this.verdict = fields.verdict;
    this.note = fields.note;
    if (fields.host !== undefined) this.host = Object.freeze({ ...fields.host });
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is DecisionImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static of(id: DecisionIdType, time: string, event: Event | ToolResult, judgement: Judgement, note?: string): Decision {
    const tool = event.kind === "session-start" ? null : event;
    return new DecisionImpl({
      id,
      time,
      event: event.kind,
      role: event.role === null ? null : event.role.value,
      tool: tool === null ? null : tool.toolKind,
      effects: tool === null ? [] : tool.effects.map((effect) => bounded(describeEffect(effect))),
      verdict: verdictOf(judgement.verdict, judgement.refusedBy),
      note: note === undefined ? null : bounded(note),
    });
  }

  static invalid(id: DecisionIdType, time: string, refusal: Verdict): Decision {
    return new DecisionImpl({ id, time, event: "invalid", role: null, tool: null, effects: [], verdict: verdictOf(refusal, null), note: null });
  }

  static adapter(id: DecisionIdType, time: string, { role, hostToolName, input, verdict }: AdapterRefusal): Decision {
    return new DecisionImpl({
      id,
      time,
      event: "adapter",
      role: typeof role === "string" ? bounded(role) : null,
      tool: null,
      effects: [],
      verdict: verdictOf(verdict, null),
      note: null,
      host: { tool: bounded(String(hostToolName)), input: summary(input) },
    });
  }

  static enforced(decision: Decision, time: string, verdict: Verdict, note: string): Decision {
    const { host, ...fields } = decision.toJSON();
    return new DecisionImpl({ ...fields, ...(host === undefined ? {} : { host }), id: decision.id, time, verdict: verdictOf(verdict, null), note: bounded(note) });
  }

  static parse(raw: unknown): Result<Decision> {
    return readSafely("A decision", () => {
      if (DecisionImpl.made(raw)) return DecisionImpl.parse(wireFormOf(raw));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: FORM };
      const id = DecisionId.parse(own(raw, "id"));
      if (!id.ok) return id;
      const fields = recorded(raw);
      return fields === undefined ? { ok: false, error: FORM } : { ok: true, value: new DecisionImpl({ ...fields, id: id.value }) };
    });
  }

  equals(other: Decision): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.DecisionJSON {
    const json = { id: this.id.value, time: this.time, event: this.event, role: this.role, tool: this.tool, effects: this.effects, verdict: this.verdict, note: this.note };
    return this.host === undefined ? json : { ...json, host: this.host };
  }
}

const FORM = "A decision is a recorded line: { id, time, event, role, tool, effects, verdict, note, host? }";
const EVENTS: readonly Contract.DecisionEvent[] = ["tool-use", "session-start", "tool-result", "invalid", "adapter"];
const isText = (raw: unknown): raw is string => typeof raw === "string";
const textOrNull = (raw: unknown): raw is string | null => raw === null || typeof raw === "string";

/** A recorded verdict read back, or undefined. */
function recordedVerdict(raw: unknown): Contract.RecordedVerdict | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const kind = own(raw, "kind");
  if (kind === "allow") return Object.freeze({ kind });
  const [reason, redirect, pack, effect] = [own(raw, "reason"), own(raw, "redirect"), own(raw, "pack"), own(raw, "effect")];
  if (kind !== "refuse" || !isText(reason) || !isText(redirect) || !textOrNull(pack) || !textOrNull(effect)) return undefined;
  return Object.freeze({ kind, reason, redirect, pack, effect });
}

/** A recorded line's fields but its id, read back, or undefined when any is malformed. */
function recorded(raw: object): Omit<Fields, "id"> | undefined {
  const [time, event, role, tool, effects, note, host] = ["time", "event", "role", "tool", "effects", "note", "host"].map((key) => own(raw, key));
  const verdict = recordedVerdict(own(raw, "verdict"));
  const kind = EVENTS.find((known) => known === event);
  const toolKind = tool === null ? null : TOOL_KINDS.find((known) => known === tool);
  if (!isText(time) || kind === undefined || !textOrNull(role) || toolKind === undefined || verdict === undefined || !textOrNull(note)) return undefined;
  if (!Array.isArray(effects) || !effects.every(isText)) return undefined;
  if (host === undefined) return { time, event: kind, role, tool: toolKind, effects, verdict, note };
  if (typeof host !== "object" || host === null || !isText(own(host, "tool")) || !isText(own(host, "input"))) return undefined;
  return { time, event: kind, role, tool: toolKind, effects, verdict, note, host: { tool: String(own(host, "tool")), input: String(own(host, "input")) } };
}

export type Decision = Contract.Decision;
export const Decision: Contract.DecisionFactory = DecisionImpl;
