import { describe, expect, test } from "bun:test";
import { Composition, type Composition as CompositionType, contribution, corePack, type Decision, definePack, packIdsFor, Verdict } from "bounded/domain";
import { JudgeEventCommand } from "./judge-event.command.ts";
import type { Clock, DecisionLog } from "./judge-event.contract.ts";
import { JudgeEventHandler } from "./judge-event.handler.ts";

const TIME = "2026-10-07T12:00:00.000Z";
const clock: Clock = { now: () => TIME };
const UNRECORDED_REDIRECT = "Make the decision log writable; until decisions can be recorded, every action is refused";

class FakeLog implements DecisionLog {
  readonly decisions: Decision[] = [];
  constructor(private readonly behaviour: (decision: Decision) => Promise<void> = async () => {}) {}

  record(decision: Decision): Promise<void> {
    this.decisions.push(decision);
    return this.behaviour(decision);
  }
}

const gate = definePack({
  id: packIdsFor("test-packs")("gate"),
  dependsOn: [corePack],
  contributes: [contribution(corePack.points.writeGuards, [(effect) => (effect.path.startsWith("generated/") ? Verdict.refuse("Generated", "Change the generator's input") : Verdict.allow)])],
});
const composed = Composition.compose([gate, corePack], [gate, corePack]);
if (!composed.ok) throw new Error(composed.error);
const composition: CompositionType = composed.value;

function command(path: string): JudgeEventCommand {
  const parsed = JudgeEventCommand.parse({ kind: "tool-use", role: "builder", tool: "edit", effects: [{ kind: "write", path, change: "modify" }] });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe("JudgeEventHandler", () => {
  test("allows, and records the decision once with its time, role, tool and effects", async () => {
    const log = new FakeLog();
    expect(await new JudgeEventHandler(composition, log, clock).execute(command("src/a.ts"))).toBe(Verdict.allow);
    expect<unknown>(log.decisions).toEqual([
      { id: log.decisions[0]?.id, time: TIME, event: "tool-use", role: "builder", tool: "edit", effects: ["write (modify) src/a.ts"], verdict: { kind: "allow" }, note: null },
    ]);
  });

  test("refuses, and records the refusal with the pack and the effect that refused", async () => {
    const log = new FakeLog();
    const verdict = await new JudgeEventHandler(composition, log, clock).execute(command("generated/a.ts"));
    expect<unknown>(verdict).toEqual({ kind: "refuse", reason: "test-packs/gate refused write (modify) generated/a.ts: Generated", redirect: "Change the generator's input" });
    expect<unknown>(log.decisions[0]?.verdict).toEqual({
      kind: "refuse",
      reason: "test-packs/gate refused write (modify) generated/a.ts: Generated",
      redirect: "Change the generator's input",
      pack: "test-packs/gate",
      effect: "write (modify) generated/a.ts",
    });
  });

  test("a refusal that cannot be recorded stays a refusal, and says so", async () => {
    const log = new FakeLog(async () => {
      throw new Error("disk full");
    });
    expect<unknown>(await new JudgeEventHandler(composition, log, clock).execute(command("generated/a.ts"))).toEqual({
      kind: "refuse",
      reason: "test-packs/gate refused write (modify) generated/a.ts: Generated (this decision could not be recorded: disk full)",
      redirect: "Change the generator's input",
    });
  });

  test("an allow that cannot be recorded becomes a refusal", async () => {
    const log = new FakeLog(async () => {
      throw new Error("disk full");
    });
    expect<unknown>(await new JudgeEventHandler(composition, log, clock).execute(command("src/a.ts"))).toEqual({
      kind: "refuse",
      reason: "The guards allowed this, but the decision could not be recorded: disk full",
      redirect: UNRECORDED_REDIRECT,
    });
  });

  test("a log that throws instead of rejecting is a failure to record", async () => {
    const log: DecisionLog = {
      record: () => {
        throw new Error("no log");
      },
    };
    const verdict = await new JudgeEventHandler(composition, log, clock).execute(command("src/a.ts"));
    expect(verdict.kind === "refuse" && verdict.reason).toBe("The guards allowed this, but the decision could not be recorded: no log");
  });

  test("a log that does not finish within the bound is a failure to record", async () => {
    const log = new FakeLog(() => new Promise<void>(() => {}));
    const verdict = await new JudgeEventHandler(composition, log, clock, { recordWithinMs: 20 }).execute(command("src/a.ts"));
    expect(verdict.kind === "refuse" && verdict.reason).toBe("The guards allowed this, but the decision could not be recorded: it did not finish within 20 ms");
  });

  test("takes decision ids from its ids port", async () => {
    const log = new FakeLog();
    let n = 0;
    await new JudgeEventHandler(composition, log, clock, { ids: { next: () => `id-${++n}` } }).execute(command("src/a.ts"));
    expect(log.decisions[0]?.id).toBe("id-1");
  });

  test("every decision has its own id", async () => {
    const log = new FakeLog();
    const handler = new JudgeEventHandler(composition, log, clock);
    await handler.execute(command("src/a.ts"));
    await handler.execute(command("src/a.ts"));
    const [first, second] = log.decisions;
    expect((first?.id ?? "").length).toBeGreaterThan(0);
    expect(first?.id).not.toBe(second?.id);
  });

  test("a record that lands after the bound is followed by a line with the same id saying what was enforced", async () => {
    const log = new FakeLog(() => Bun.sleep(60));
    const verdict = await new JudgeEventHandler(composition, log, clock, { recordWithinMs: 20 }).execute(command("src/a.ts"));
    expect(verdict.kind).toBe("refuse");
    await Bun.sleep(150);
    const [original, followUp] = log.decisions;
    expect(log.decisions.length).toBe(2);
    expect(original?.verdict.kind).toBe("allow");
    expect(followUp?.id).toBe(original?.id ?? "missing");
    expect(followUp?.note).toBe("not recorded in time; enforced: refuse");
    expect<unknown>(followUp?.verdict).toEqual({
      kind: "refuse",
      reason: "The guards allowed this, but the decision could not be recorded: it did not finish within 20 ms",
      redirect: UNRECORDED_REDIRECT,
      pack: null,
      effect: null,
    });
  });

  test("a clock that does not give an ISO 8601 time is a failure to record", async () => {
    const odd: Clock = { now: () => "yesterday" };
    const log = new FakeLog();
    const verdict = await new JudgeEventHandler(composition, log, odd).execute(command("src/a.ts"));
    expect(verdict.kind === "refuse" && verdict.reason).toBe("The guards allowed this, but the decision could not be recorded: the clock gave 'yesterday', not an ISO 8601 time");
    expect(log.decisions).toEqual([]);
  });

  test("something that is not a command is refused, never thrown, and nothing is recorded", async () => {
    const log = new FakeLog();
    const handler = new JudgeEventHandler(composition, log, clock);
    for (const raw of [null, undefined, 7, {}, { event: { kind: "deploy" } }]) {
      const verdict = await handler.execute(raw as unknown as JudgeEventCommand);
      expect(verdict.kind === "refuse" && verdict.reason.startsWith("The handler was given something that is not a judge-event command")).toBe(true);
    }
    expect(log.decisions).toEqual([]);
  });

  test("refuses to be built with a bound that is not a finite number of milliseconds above zero", () => {
    for (const recordWithinMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new JudgeEventHandler(composition, new FakeLog(), clock, { recordWithinMs })).toThrow("recordWithinMs must be a finite number of milliseconds above zero");
    }
  });

  test("judges an event in its wire form, as execute does", async () => {
    const log = new FakeLog();
    const verdict = await new JudgeEventHandler(composition, log, clock).judge({ kind: "tool-use", role: "builder", tool: "edit", effects: [{ kind: "write", path: "generated/a.ts", change: "modify" }] });
    expect(verdict.kind).toBe("refuse");
    expect(log.decisions[0]?.event).toBe("tool-use");
  });

  test("an event that cannot be read is refused and recorded as invalid", async () => {
    const log = new FakeLog();
    const verdict = await new JudgeEventHandler(composition, log, clock).judge({ kind: "tool-use", role: null });
    expect(verdict.kind === "refuse" && verdict.reason.startsWith("The host sent an event that cannot be read: ")).toBe(true);
    expect(log.decisions.length).toBe(1);
    expect(log.decisions[0]?.event).toBe("invalid");
    expect(log.decisions[0]?.verdict.kind).toBe("refuse");
  });

  test("a handler made to refuse everything refuses every event with that refusal, and records it", async () => {
    const log = new FakeLog();
    const handler = new JudgeEventHandler(null, log, clock, { refuseEverything: Verdict.refuse("The configuration cannot be loaded: broken", "Fix bounded.config.ts") });
    expect<unknown>(await handler.execute(command("src/a.ts"))).toEqual({ kind: "refuse", reason: "The configuration cannot be loaded: broken", redirect: "Fix bounded.config.ts" });
    expect(log.decisions[0]?.verdict.kind).toBe("refuse");
  });

  test("records within two seconds by default", () => {
    expect(JudgeEventHandler.DEFAULT_RECORD_WITHIN_MS).toBe(2000);
  });

  test("a clock that fails is a failure to record", async () => {
    const broken: Clock = {
      now: () => {
        throw new Error("no time");
      },
    };
    const verdict = await new JudgeEventHandler(composition, new FakeLog(), broken).execute(command("src/a.ts"));
    expect(verdict.kind === "refuse" && verdict.reason).toBe("The guards allowed this, but the decision could not be recorded: no time");
  });

  test("never throws: a broken composition is refused, and that refusal is recorded", async () => {
    const log = new FakeLog();
    const verdict = await new JudgeEventHandler(null as unknown as CompositionType, log, clock).execute(command("src/a.ts"));
    expect(verdict.kind).toBe("refuse");
    expect(log.decisions.length).toBe(1);
  });
});
