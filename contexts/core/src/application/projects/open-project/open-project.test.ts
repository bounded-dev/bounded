import { describe, expect, test } from "bun:test";
import { type Config, contribution, corePack, type Decision, defineConfig, definePack, packIdsFor, type Result, Verdict, type WriteEffect } from "bounded/domain";
import type { Clock, DecisionLog } from "../../judging/judge-event/judge-event.contract.ts";
import { OpenProjectCommand } from "./open-project.command.ts";
import type { ProjectConfigSource, ProjectDecisionLogs } from "./open-project.contract.ts";
import { OpenProjectHandler } from "./open-project.handler.ts";

const clock: Clock = { now: () => "2026-10-07T12:00:00.000Z" };
const FIX = "Fix bounded.config.ts in the project root (see docs/configuration.md); until then every action is refused";

class Logs implements ProjectDecisionLogs {
  readonly decisions: Decision[] = [];
  readonly roots: string[] = [];
  forProject(root: string): DecisionLog {
    this.roots.push(root);
    return { record: async (decision) => void this.decisions.push(decision) };
  }
}

const source = (loaded: () => Promise<Result<Config>>): ProjectConfigSource => ({ load: loaded });
const root = OpenProjectCommand.parse({ root: "/work/project" });
if (!root.ok) throw new Error(root.error);
const command = root.value;
const write = (path: string) => ({ kind: "tool-use", role: "builder", tool: "edit", effects: [{ kind: "write", path, change: "modify" }] });

const noGenerated = (effect: WriteEffect) => (effect.path.startsWith("generated/") ? Verdict.refuse("Generated", "Change the generator's input") : Verdict.allow);
const config = defineConfig({ packs: [corePack], contributes: [contribution(corePack.points.writeGuards, [noGenerated])] });

describe("OpenProjectHandler", () => {
  test("opens a project whose configuration loads: its judge decides with the composed packs and records in the project's log", async () => {
    const logs = new Logs();
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: config })), logs, clock).execute(command);
    expect(project.problem).toBeNull();
    expect(await project.judge(write("src/a.ts"))).toBe(Verdict.allow);
    expect<unknown>(await project.judge(write("generated/a.ts"))).toEqual({ kind: "refuse", reason: "bounded/project refused write (modify) generated/a.ts: Generated", redirect: "Change the generator's input" });
    expect(logs.roots).toEqual(["/work/project"]);
    expect(logs.decisions.length).toBe(2);
  });

  test("an event that cannot be read is refused and recorded", async () => {
    const logs = new Logs();
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: config })), logs, clock).execute(command);
    expect((await project.judge({ kind: "tool-use" })).kind).toBe("refuse");
    expect(logs.decisions[0]?.event).toBe("invalid");
  });

  test("a configuration that cannot be loaded gives a judge that refuses every event with the reason, and records it", async () => {
    const logs = new Logs();
    const project = await new OpenProjectHandler(source(async () => ({ ok: false, error: "No configuration in /work/project" })), logs, clock).execute(command);
    expect(project.problem).toBe("No configuration in /work/project");
    expect<unknown>(await project.judge(write("src/a.ts"))).toEqual({ kind: "refuse", reason: "This project's configuration cannot be used: No configuration in /work/project", redirect: FIX });
    expect(logs.decisions[0]?.verdict.kind).toBe("refuse");
  });

  test("a configuration source that throws is a configuration that cannot be loaded", async () => {
    const project = await new OpenProjectHandler(
      source(async () => {
        throw new Error("disk gone");
      }),
      new Logs(),
      clock,
    ).execute(command);
    expect(project.problem).toBe("the configuration source failed: disk gone");
    expect((await project.judge(write("src/a.ts"))).kind).toBe("refuse");
  });

  test("a configuration whose packs cannot be composed gives a judge that refuses every event", async () => {
    const words = definePack({ id: packIdsFor("test-packs")("words") });
    const needs = definePack({ id: packIdsFor("test-packs")("needs"), dependsOn: [words] });
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: defineConfig({ packs: [corePack, needs] }) })), new Logs(), clock).execute(command);
    expect(project.problem).toBe("its packs cannot be composed: Pack 'test-packs/needs' depends on pack 'test-packs/words', which is not selected. Select it as well, or remove the dependency");
    const verdict = await project.judge(write("src/a.ts"));
    expect(verdict.kind === "refuse" && verdict.reason.startsWith("This project's configuration cannot be used: its packs cannot be composed")).toBe(true);
  });

  test("a project whose log cannot be opened still refuses: nothing is allowed unrecorded", async () => {
    const logs: ProjectDecisionLogs = {
      forProject: () => {
        throw new Error("read-only file system");
      },
    };
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: config })), logs, clock).execute(command);
    const verdict = await project.judge(write("src/a.ts"));
    expect(verdict.kind === "refuse" && verdict.reason).toBe("The guards allowed this, but the decision could not be recorded: read-only file system");
  });
});
