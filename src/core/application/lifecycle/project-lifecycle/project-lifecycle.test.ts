import { describe, expect, test } from "bun:test";
import {
  type AfterTool,
  type BeforeTool,
  type BasePack,
  Composition,
  contribution,
  corePack,
  type Decision,
  DecisionId,
  DecisionTime,
  definePack,
  packIdsFor,
  Ports,
  ToolResult,
  ToolUse,
  Verdict,
} from "bounded/domain";
import type { Clock, BoundedLog } from "./project-lifecycle.contract.ts";
import { ProjectLifecycleHandler } from "./project-lifecycle.handler.ts";

const packId = packIdsFor("test-packs");
const clock: Clock = { now: () => parsed(DecisionTime.parse("2026-10-07T12:00:00.000Z")) };
const ids = { next: (() => {
  let n = 0;
  return () => parsed(DecisionId.parse(`d-${++n}`));
})() };

class Log implements BoundedLog {
  readonly decisions: Decision[] = [];
  async record(decision: Decision): Promise<void> {
    this.decisions.push(decision);
  }
}

function parsed<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const call = parsed(ToolUse.parse({ role: "builder", tool: "shell", callId: "c1", effects: [{ kind: "execute", command: "make", reading: { outcome: "unread", why: "the parser could not load" } }] }));
const result = parsed(ToolResult.parse({ role: "builder", tool: "shell", callId: "c1", ok: true, effects: [{ kind: "execute", command: "make", reading: { outcome: "unread", why: "the parser could not load" } }] }));

function lifecycle(packs: readonly BasePack[], log: BoundedLog = new Log()) {
  const composition = parsed(Composition.compose([corePack, ...packs], [corePack, ...packs]));
  const ports = parsed(Ports.forProject("/work/project", []));
  return { handler: new ProjectLifecycleHandler(composition, ports, log, clock, { ids }), composition, ports };
}
const [a, b] = [packId("a"), packId("b")];
/** A pack that depends on the core, built without its id checked at compile time, so one helper serves both test packs. */
const packOf = definePack as unknown as (spec: object) => BasePack;
const before = (id: typeof a | typeof b, checks: BeforeTool[]) => packOf({ id, dependsOn: [corePack], contributes: [contribution(corePack.points.beforeTool, checks)] });
const after = (id: typeof a | typeof b, checks: AfterTool[]) => packOf({ id, dependsOn: [corePack], contributes: [contribution(corePack.points.afterTool, checks)] });

/** A before-tool check that notes its name and answers `verdict`. */
const noting =
  (seen: string[], name: string, verdict: Verdict = Verdict.allow): BeforeTool =>
  async () => {
    seen.push(name);
    return verdict;
  };

describe("ProjectLifecycleHandler — before a tool runs", () => {
  test("runs every before-tool check in pack order, each given the call, the composition and the ports", async () => {
    const seen: string[] = [];
    const { handler, composition, ports } = lifecycle([
      before(b, [
        async (given, context) => {
          seen.push(`b ${given.callId?.value} ${context.composition === composition} ${context.ports === ports}`);
          return Verdict.allow;
        },
      ]),
      before(a, [noting(seen, "a")]),
    ]);
    expect(await handler.before(call)).toBe(Verdict.allow);
    expect(seen).toEqual(["a", "b c1 true true"]);
  });

  test("the first refusal wins and later checks do not run", async () => {
    const seen: string[] = [];
    const { handler } = lifecycle([
      before(a, [noting(seen, "a", Verdict.refuse("Not now", "Later")), noting(seen, "a2")]),
    ]);
    expect<unknown>(await handler.before(call)).toEqual({ kind: "refuse", reason: "Not now", redirect: "Later" });
    expect(seen).toEqual(["a"]);
  });

  test("a check that throws, or answers with something that is not a verdict, refuses naming its pack", async () => {
    const throwing = lifecycle([before(a, [async () => { throw new Error("boom"); }])]).handler;
    expect<unknown>(await throwing.before(call)).toEqual({
      kind: "refuse",
      reason: "test-packs/a could not check this call before it ran: boom",
      redirect: "Report this to the maintainers of test-packs/a; the action is refused meanwhile",
    });
    const odd = lifecycle([before(a, [async () => "yes" as never])]).handler;
    const verdict = await odd.before(call);
    expect(verdict.kind === "refuse" && verdict.reason.startsWith("test-packs/a could not check this call before it ran: it answered with something that is not a verdict")).toBe(true);
  });
});

describe("ProjectLifecycleHandler — after a tool ran", () => {
  test("runs every after-tool check in pack order, records each report's record and joins the messages", async () => {
    const log = new Log();
    const { handler } = lifecycle(
      [
        after(a, [async () => ({ message: "First", record: { verdict: Verdict.refuse("changed", "restore"), refusedBy: { effect: result.effects[0] ?? null }, note: "changed; restored" } })]),
        after(b, [async () => ({ message: "Second", record: null }), async () => ({ message: null, record: null })]),
      ],
      log,
    );
    expect(await handler.after(result)).toEqual({ message: "First\n\nSecond" });
    expect(log.decisions.length).toBe(1);
    expect(log.decisions[0]?.toJSON()).toMatchObject({ event: "tool-result", note: "changed; restored", verdict: { kind: "refuse", reason: "changed", redirect: "restore", pack: "test-packs/a", effect: "execute `make`" } });
  });

  test("with nothing to say, the message is null", async () => {
    expect(await lifecycle([]).handler.after(result)).toEqual({ message: null });
  });

  test("a check that throws or reports nonsense says so, and is recorded with no pack named", async () => {
    const log = new Log();
    const { handler } = lifecycle([after(a, [async () => { throw new Error("boom"); }, async () => "done" as never])], log);
    expect(await handler.after(result)).toEqual({
      message: "test-packs/a could not check this call after it ran: boom\n\ntest-packs/a could not check this call after it ran: it reported something that is not an after-tool report",
    });
    expect(log.decisions.map((decision) => JSON.parse(JSON.stringify(decision)).verdict.pack)).toEqual([null, null]);
  });

  test("a record that cannot be written is swallowed: the message still reaches the host", async () => {
    const failing: BoundedLog = { record: async () => { throw new Error("disk full"); } };
    const { handler } = lifecycle([after(a, [async () => ({ message: "Restored", record: { verdict: Verdict.refuse("changed", "restore"), refusedBy: null, note: "n" } })])], failing);
    expect(await handler.after(result)).toEqual({ message: "Restored" });
  });
});
