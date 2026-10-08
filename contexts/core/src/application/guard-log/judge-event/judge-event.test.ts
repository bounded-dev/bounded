import { describe, expect, test } from "bun:test";
import { Composition, type Composition as CompositionType, contribution, corePack, type Decision, DecisionId, DecisionTime, definePack, packIdsFor, Verdict } from "bounded/domain";
import { JudgeEventCommand } from "./judge-event.command.ts";
import type { Clock, DecisionIds, GuardLog, ShellCommandReader } from "./judge-event.contract.ts";
import { JudgeEventHandler } from "./judge-event.handler.ts";

const TIME = "2026-10-07T12:00:00.000Z";
/** A DecisionTime from known-good text. */
function decisionTime(text: string): DecisionTime {
  const parsed = DecisionTime.parse(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
/** A DecisionId from known-good text. */
function decisionId(text: string): DecisionId {
  const parsed = DecisionId.parse(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
const clock: Clock = { now: () => decisionTime(TIME) };
const UNRECORDED_REDIRECT = "Make the guard log writable; until decisions can be recorded, every action is refused";

class FakeLog implements GuardLog {
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
  contributes: [contribution(corePack.points.effectGuards.write, [(effect) => (effect.path.value.startsWith("generated/") ? Verdict.refuse("Generated", "Change the generator's input") : Verdict.allow)])],
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
    const log: GuardLog = {
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
    await new JudgeEventHandler(composition, log, clock, { ids: { next: () => decisionId(`id-${++n}`) } }).execute(command("src/a.ts"));
    expect(log.decisions[0]?.id.value).toBe("id-1");
  });

  test("every decision has its own id", async () => {
    const log = new FakeLog();
    const handler = new JudgeEventHandler(composition, log, clock);
    await handler.execute(command("src/a.ts"));
    await handler.execute(command("src/a.ts"));
    const [first, second] = log.decisions;
    expect((first?.id.value ?? "").length).toBeGreaterThan(0);
    expect(first?.id.value).not.toBe(second?.id.value);
  });

  test("a record that lands after the bound is followed by a line with the same id saying what was enforced", async () => {
    const log = new FakeLog(() => Bun.sleep(60));
    const verdict = await new JudgeEventHandler(composition, log, clock, { recordWithinMs: 20 }).execute(command("src/a.ts"));
    expect(verdict.kind).toBe("refuse");
    await Bun.sleep(150);
    const [original, followUp] = log.decisions;
    expect(log.decisions.length).toBe(2);
    expect(original?.verdict.kind).toBe("allow");
    expect(followUp?.id.value).toBe(original?.id.value ?? "missing");
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
    // A host's clock is unchecked at run time: one giving text that is not a time is caught when the decision is recorded.
    const odd = { now: () => "yesterday" } as unknown as Clock;
    const log = new FakeLog();
    const verdict = await new JudgeEventHandler(composition, log, odd).execute(command("src/a.ts"));
    expect(verdict.kind === "refuse" && verdict.reason).toBe("The guards allowed this, but the decision could not be recorded: the clock gave 'yesterday', not an ISO 8601 time");
    expect(log.decisions).toEqual([]);
  });

  test("a host clock that still gives an ISO 8601 string is accepted, with the same check", async () => {
    const textClock = { now: () => TIME } as unknown as Clock;
    const log = new FakeLog();
    expect(await new JudgeEventHandler(composition, log, textClock).execute(command("src/a.ts"))).toBe(Verdict.allow);
    expect(log.decisions.length).toBe(1);
    expect(log.decisions[0]?.time).toBe(TIME);
  });

  test("a clock that gives something DecisionTime did not make is a failure to record", async () => {
    const lookAlike = { value: TIME, equals: () => true, toJSON: () => TIME };
    const forged = { now: () => lookAlike } as unknown as Clock;
    const log = new FakeLog();
    const verdict = await new JudgeEventHandler(composition, log, forged).execute(command("src/a.ts"));
    expect(verdict.kind).toBe("refuse");
    const reason = verdict.kind === "refuse" ? verdict.reason : "";
    expect(reason).toStartWith("The guards allowed this, but the decision could not be recorded: the clock gave '");
    expect(reason).toEndWith("', not an ISO 8601 time");
    expect(log.decisions).toEqual([]);
  });

  test("an ids source that gives something DecisionId did not make is a failure to record", async () => {
    const lookAlike = { value: "id-1", equals: () => true, toJSON: () => "id-1" };
    const forged = { next: () => lookAlike } as unknown as DecisionIds;
    const log = new FakeLog();
    const verdict = await new JudgeEventHandler(composition, log, clock, { ids: forged }).execute(command("src/a.ts"));
    expect(verdict.kind === "refuse" && verdict.reason).toContain("the decision ids gave an invalid id");
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

  test("a check before allowing can still refuse; the refusal is what is recorded", async () => {
    const log = new FakeLog();
    const seen: string[] = [];
    const handler = new JudgeEventHandler(composition, log, clock, {
      beforeAllow: async (event) => {
        seen.push(event.kind);
        return Verdict.refuse("Not now", "Later");
      },
    });
    expect<unknown>(await handler.execute(command("src/a.ts"))).toEqual({ kind: "refuse", reason: "Not now", redirect: "Later" });
    expect(log.decisions[0]?.verdict.kind).toBe("refuse");
    await handler.execute(command("generated/a.ts"));
    expect(seen).toEqual(["tool-use"]);
  });

  test("a check before allowing that throws refuses", async () => {
    const handler = new JudgeEventHandler(composition, new FakeLog(), clock, {
      beforeAllow: async () => {
        throw new Error("no snapshot");
      },
    });
    const verdict = await handler.execute(command("src/a.ts"));
    expect(verdict.kind === "refuse" && verdict.reason).toBe("The check before allowing this failed: no snapshot");
  });

  test("a refusal the host adapter made itself is recorded and returned", async () => {
    const log = new FakeLog();
    const verdict = await new JudgeEventHandler(composition, log, clock).refuse({ role: "builder", hostToolName: "Bash", reason: "the path is outside the project", redirect: "Use a path inside it", input: { command: "cat /etc/passwd" } });
    expect<unknown>(verdict).toEqual({ kind: "refuse", reason: "the path is outside the project", redirect: "Use a path inside it" });
    expect(log.decisions[0]?.event).toBe("adapter");
    expect(log.decisions[0]?.host).toEqual({ tool: "Bash", input: '{"command":"cat /etc/passwd"}' });
  });

  test("an adapter refusal that cannot be recorded stays a refusal, and says so; garbage input still refuses", async () => {
    const failing = new FakeLog(async () => {
      throw new Error("disk full");
    });
    const verdict = await new JudgeEventHandler(composition, failing, clock).refuse({ hostToolName: "Bash", reason: "outside", redirect: "inside" });
    expect(verdict.kind === "refuse" && verdict.reason).toBe("outside (this decision could not be recorded: disk full)");
    const odd = await new JudgeEventHandler(composition, new FakeLog(), clock).refuse(null as never);
    expect(odd.kind).toBe("refuse");
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

describe("JudgeEventHandler — reading shell commands", () => {
  const ROOT = "/work/project";
  /** A pack whose execute guard refuses with the reading it was given, as JSON, so a test can see it. */
  const showsReading = definePack({
    id: packIdsFor("test-packs")("shows-reading"),
    dependsOn: [corePack],
    contributes: [contribution(corePack.points.effectGuards.execute, [(effect) => Verdict.refuse(JSON.stringify(effect.reading), "Seen")])],
  });
  const shown = Composition.compose([showsReading, corePack], [showsReading, corePack]);
  if (!shown.ok) throw new Error(shown.error);
  const showing: CompositionType = shown.value;
  const reading = (name: string) => ({ outcome: "read", programs: [{ name: { kind: "literal", text: name }, arguments: [{ kind: "literal", text: "x" }], workingDirectory: "." }], fileEffects: [{ effect: { kind: "read", path: "x" } }], unresolved: [] });
  const shell = (effects: object[]) => ({ kind: "tool-use", role: null, tool: "shell", effects, callId: "c-1" });
  const unread = (why: string) => JSON.stringify({ outcome: "unread", why });
  const reasonOf = (verdict: Verdict): string => (verdict.kind === "refuse" ? verdict.reason : "allowed");
  const answering = (answer: (command: string) => Promise<unknown>): ShellCommandReader => ({ prepare: async () => {}, read: (_root, command) => answer(command.value) });

  test("every execute effect is read by the project's reader before guards run, and guards see the reading", async () => {
    const calls: unknown[] = [];
    const reader: ShellCommandReader = {
      prepare: async () => {},
      read: async (projectRoot, command, cwd) => {
        calls.push([projectRoot, command.value, cwd === null ? null : cwd.value]);
        return reading("tool-a");
      },
    };
    const handler = new JudgeEventHandler(showing, new FakeLog(), clock, { shellCommandReader: reader, projectRoot: ROOT });
    const verdict = await handler.judge(shell([{ kind: "execute", command: "tool-a x", cwd: "app" }]));
    expect(reasonOf(verdict)).toBe(`test-packs/shows-reading refused execute \`tool-a x\` in app: ${JSON.stringify(reading("tool-a"))}`);
    expect(calls).toEqual([[ROOT, "tool-a x", "app"]]);
  });

  test("a reading the host sent is replaced, never trusted", async () => {
    const handler = new JudgeEventHandler(showing, new FakeLog(), clock, { shellCommandReader: answering(async () => reading("tool-a")), projectRoot: ROOT });
    const verdict = await handler.judge(shell([{ kind: "execute", command: "tool-a x", reading: reading("harmless") }]));
    expect(reasonOf(verdict)).toEndWith(`: ${JSON.stringify(reading("tool-a"))}`);
  });

  test("without a reader, every execute is judged unread, saying the host passes one", async () => {
    const verdict = await new JudgeEventHandler(showing, new FakeLog(), clock).judge(shell([{ kind: "execute", command: "ls" }]));
    expect(reasonOf(verdict)).toBe(`test-packs/shows-reading refused execute \`ls\`: ${unread("this project was opened without a shell command reader: the host passes one to openProject")}`);
  });

  test("a reader that rejects leaves the command unread, saying why", async () => {
    const log = new FakeLog();
    const reader = answering(async () => {
      throw new Error("bounded's shell parser could not load (main.wasm is missing)");
    });
    const verdict = await new JudgeEventHandler(showing, log, clock, { shellCommandReader: reader, projectRoot: ROOT }).judge(shell([{ kind: "execute", command: "ls" }]));
    expect(reasonOf(verdict)).toEndWith(`: ${unread("bounded's shell parser could not load (main.wasm is missing)")}`);
    expect(log.decisions.length).toBe(1);
  });

  test("a reader that throws instead of rejecting leaves the command unread, saying why", async () => {
    const reader: ShellCommandReader = {
      prepare: async () => {},
      read: () => {
        throw new Error("no grammar");
      },
    };
    const verdict = await new JudgeEventHandler(showing, new FakeLog(), clock, { shellCommandReader: reader, projectRoot: ROOT }).judge(shell([{ kind: "execute", command: "ls" }]));
    expect(reasonOf(verdict)).toEndWith(`: ${unread("no grammar")}`);
  });

  test("a reader that does not answer within readWithinMs leaves the command unread, saying it timed out", async () => {
    const reader = answering(() => new Promise(() => {}));
    const verdict = await new JudgeEventHandler(showing, new FakeLog(), clock, { shellCommandReader: reader, projectRoot: ROOT, readWithinMs: 30 }).judge(shell([{ kind: "execute", command: "ls" }]));
    expect(reasonOf(verdict)).toEndWith(`: ${unread("reading the command did not finish within 30 ms (timed out)")}`);
  });

  test("readWithinMs bounds the whole event, not each read", async () => {
    const seen: string[] = [];
    const collects = definePack({
      id: packIdsFor("test-packs")("collects"),
      dependsOn: [corePack],
      contributes: [
        contribution(corePack.points.effectGuards.execute, [
          (effect) => {
            seen.push(effect.reading?.outcome ?? "none");
            return Verdict.allow;
          },
        ]),
      ],
    });
    const composed = Composition.compose([collects, corePack], [collects, corePack]);
    if (!composed.ok) throw new Error(composed.error);
    const slow = answering(async (command) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return reading(command);
    });
    const handler = new JudgeEventHandler(composed.value, new FakeLog(), clock, { shellCommandReader: slow, projectRoot: ROOT, readWithinMs: 150 });
    expect(await handler.judge(shell([{ kind: "execute", command: "tool-a" }, { kind: "execute", command: "tool-b" }]))).toBe(Verdict.allow);
    expect(seen).toEqual(["read", "read"]);
  });

  test("a reading the reader gives that cannot be used leaves the command unread", async () => {
    const verdict = await new JudgeEventHandler(showing, new FakeLog(), clock, { shellCommandReader: answering(async () => ({ outcome: "maybe" })), projectRoot: ROOT }).judge(shell([{ kind: "execute", command: "ls" }]));
    expect(reasonOf(verdict)).toEndWith(
      `: ${unread("the shell command reader gave a reading that cannot be used: A shell command reading is { outcome: 'read', programs, fileEffects, unresolved } or { outcome: 'unread', why }")}`,
    );
  });

  test("beforeAllow sees the read event", async () => {
    const seen: unknown[] = [];
    const handler = new JudgeEventHandler(composition, new FakeLog(), clock, {
      shellCommandReader: answering(async () => reading("tool-a")),
      projectRoot: ROOT,
      beforeAllow: async (event) => {
        if (event.kind === "tool-use") for (const effect of event.effects) if (effect.kind === "execute") seen.push(effect.reading?.toJSON());
        return Verdict.allow;
      },
    });
    expect(await handler.judge(shell([{ kind: "execute", command: "tool-a x" }]))).toBe(Verdict.allow);
    expect(seen).toEqual([reading("tool-a")]);
  });

  test("a reader without the project's root is refused when the handler is made", () => {
    expect(() => new JudgeEventHandler(showing, new FakeLog(), clock, { shellCommandReader: answering(async () => reading("tool-a")) })).toThrow(new RangeError("a shell command reader needs the project's root"));
  });
});
