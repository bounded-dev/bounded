import { describe, expect, test } from "bun:test";
import { type Config, contribution, corePack, type Decision, defineConfig, definePack, packIdsFor, portKeysFor, Ports, ProjectPath, type ProjectOpenHandler, type Result, Verdict, type WriteEffect } from "bounded/domain";
import type { Clock, GuardLog } from "../../guard-log/judge-event/judge-event.contract.ts";
import { OpenProjectCommand } from "./open-project.command.ts";
import type { ProjectConfigSource, ProjectGuardLogs, ProjectPathKinds } from "./open-project.contract.ts";
import { OpenProjectHandler } from "./open-project.handler.ts";

/** A project path, as the core makes them. */
const pathOf = (raw: string): ProjectPath => {
  const path = ProjectPath.parse(raw);
  if (!path.ok) throw new Error(path.error);
  return path.value;
};
const clock: Clock = { now: () => "2026-10-07T12:00:00.000Z" };
const FIX = "Fix bounded.config.ts in the project root (see docs/configuration.md); until then every action is refused";

class Logs implements ProjectGuardLogs {
  readonly decisions: Decision[] = [];
  readonly roots: string[] = [];
  forProject(root: string): GuardLog {
    this.roots.push(root);
    return { record: async (decision) => void this.decisions.push(decision) };
  }
}

const source = (loaded: () => Promise<Result<Config>>): ProjectConfigSource => ({ load: loaded });
const root = OpenProjectCommand.parse({ projectRoot: "/work/project" });
if (!root.ok) throw new Error(root.error);
const command = root.value;
const write = (path: string) => ({ kind: "tool-use", role: "builder", tool: "edit", effects: [{ kind: "write", path, change: "modify" }] });

const noGenerated = (effect: WriteEffect) => (effect.path.value.startsWith("generated/") ? Verdict.refuse("Generated", "Change the generator's input") : Verdict.allow);
const config = defineConfig({ packs: [corePack], contributes: [contribution(corePack.points.effectGuards.write, [noGenerated])] });

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

  test("never rejects: a bound that cannot be used gives a judge that refuses every event, still recording", async () => {
    const logs = new Logs();
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: config })), logs, clock, { recordWithinMs: -1 }).execute(command);
    expect(project.problem).toBe("recordWithinMs must be a finite number of milliseconds above zero");
    expect((await project.judge(write("src/a.ts"))).kind).toBe("refuse");
    expect(logs.decisions.length).toBe(1);
  });

  test("a configuration whose packs cannot be composed gives a judge that refuses every event", async () => {
    const words = definePack({ id: packIdsFor("test-packs")("words") });
    const needs = definePack({ id: packIdsFor("test-packs")("needs"), dependsOn: [words] });
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: defineConfig({ packs: [corePack, needs] }) })), new Logs(), clock).execute(command);
    expect(project.problem).toBe("its packs cannot be composed: Pack 'test-packs/needs' depends on pack 'test-packs/words', which is not selected. Select it as well, or remove the dependency");
    const verdict = await project.judge(write("src/a.ts"));
    expect(verdict.kind === "refuse" && verdict.reason.startsWith("This project's configuration cannot be used: its packs cannot be composed")).toBe(true);
  });

  test("a tool result that cannot be read is reported, and changes nothing", async () => {
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: config })), new Logs(), clock).execute(command);
    const check = await project.afterTool({ kind: "tool-result" });
    expect(check).toEqual({ message: check.message ?? "" });
    expect(check.message?.startsWith("The host sent a tool result that cannot be read: ")).toBe(true);
  });

  test("records a refusal the host adapter made itself, even when the configuration is broken", async () => {
    const logs = new Logs();
    const healthy = await new OpenProjectHandler(source(async () => ({ ok: true, value: config })), logs, clock).execute(command);
    expect((await healthy.refuse({ hostToolName: "Bash", reason: "outside", redirect: "inside" })).kind).toBe("refuse");
    const broken = await new OpenProjectHandler(source(async () => ({ ok: false, error: "no config" })), logs, clock).execute(command);
    expect((await broken.refuse({ hostToolName: "Bash", reason: "outside", redirect: "inside" })).kind).toBe("refuse");
    expect(logs.decisions.map((d) => d.event)).toEqual(["adapter", "adapter"]);
  });

  test("a project whose log cannot be opened still refuses: nothing is allowed unrecorded", async () => {
    const logs: ProjectGuardLogs = {
      forProject: () => {
        throw new Error("read-only file system");
      },
    };
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: config })), logs, clock).execute(command);
    const verdict = await project.judge(write("src/a.ts"));
    expect(verdict.kind === "refuse" && verdict.reason).toBe("The guards allowed this, but the decision could not be recorded: read-only file system");
  });

  test("what packs do when a project opens runs before it is judged, given the project's root and what is at a path", async () => {
    const seen: { root: string; kind: unknown; composed: boolean }[] = [];
    const opening: ProjectOpenHandler = async (project, composition) => {
      seen.push({ root: project.root, kind: project.kindOfPath(pathOf("src/a.ts")), composed: composition.read(corePack.points.onProjectOpen).ok });
    };
    const preparing = defineConfig({ packs: [corePack], contributes: [contribution(corePack.points.onProjectOpen, [opening])] });
    const pathKinds: ProjectPathKinds = { forProject: (projectRoot) => (path) => (projectRoot === "/work/project" && path.value === "src/a.ts" ? "file" : "absent") };
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: preparing })), new Logs(), clock, { pathKinds }).execute(command);
    expect(project.problem).toBeNull();
    expect(seen).toEqual([{ root: "/work/project", kind: "file", composed: true }]);
  });

  test("a pack whose work on opening fails does not stop the project opening: its own guards answer for it", async () => {
    const failing: ProjectOpenHandler = async () => {
      throw new Error("the parser could not load");
    };
    const preparing = defineConfig({ packs: [corePack], contributes: [contribution(corePack.points.onProjectOpen, [failing])] });
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: preparing })), new Logs(), clock).execute(command);
    expect(project.problem).toBeNull();
    expect(await project.judge(write("src/a.ts"))).toBe(Verdict.allow);
  });

  test("without a way to ask what is at a path, a pack is told it cannot know", async () => {
    let kind: unknown = "unset";
    const opening: ProjectOpenHandler = async (project) => {
      kind = project.kindOfPath(pathOf("src/a.ts"));
    };
    const preparing = defineConfig({ packs: [corePack], contributes: [contribution(corePack.points.onProjectOpen, [opening])] });
    await new OpenProjectHandler(source(async () => ({ ok: true, value: preparing })), new Logs(), clock).execute(command);
    expect(kind).toBeUndefined();
  });

  test("a pack's work on opening that never finishes is cut off, so the project still opens", async () => {
    const hanging: ProjectOpenHandler = () => new Promise(() => {});
    const preparing = defineConfig({ packs: [corePack], contributes: [contribution(corePack.points.onProjectOpen, [hanging])] });
    const started = performance.now();
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: preparing })), new Logs(), clock, { prepareWithinMs: 50 }).execute(command);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(project.problem).toBeNull();
    expect(await project.judge(write("src/a.ts"))).toBe(Verdict.allow);
  });

  test("a selected pack's port that the host does not provide makes the judge refuse every event, saying what to pass", async () => {
    const gateId = packIdsFor("test-packs")("gate");
    const gate = definePack({ id: gateId, dependsOn: [corePack], ports: { files: portKeysFor(gateId)<{ read(): string }>("files") } });
    const logs = new Logs();
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: defineConfig({ packs: [corePack, gate] }) })), logs, clock).execute(command);
    expect(project.problem).toBe("test-packs/gate needs the port 'files', which this host does not provide: pass it to openProject({ ports })");
    expect((await project.judge(write("src/a.ts"))).kind).toBe("refuse");
    expect(logs.decisions.length).toBe(1);
  });

  test("before- and after-tool checks run with the ports the host provides: a refusal before replaces the allow, a message after reaches the host", async () => {
    const gateId = packIdsFor("test-packs")("gate");
    const files = portKeysFor(gateId)<{ read(): string }>("files");
    const gate = definePack({
      id: gateId,
      dependsOn: [corePack],
      contributes: [
        contribution(corePack.points.beforeTool, [async (call, context) => {
          const port = context.ports.get(files);
          return port.ok && port.value.read() === "locked" && call.effects.some((effect) => effect.kind === "execute") ? Verdict.refuse("Locked", "Wait") : Verdict.allow;
        }]),
        contribution(corePack.points.afterTool, [async () => ({ message: "Checked after", record: null })]),
      ],
      ports: { files },
    });
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: defineConfig({ packs: [corePack, gate] }) })), new Logs(), clock, {
      ports: [Ports.provide(files, () => ({ read: () => "locked" }))],
    }).execute(command);
    expect(project.problem).toBeNull();
    const shell = { kind: "tool-use", role: null, tool: "shell", effects: [{ kind: "execute", command: "make" }], callId: "c1" };
    expect<unknown>(await project.judge(shell)).toEqual({ kind: "refuse", reason: "Locked", redirect: "Wait" });
    expect(await project.judge(write("src/a.ts"))).toBe(Verdict.allow);
    expect((await project.afterTool({ ...shell, kind: "tool-result", ok: true })).message).toBe("Checked after");
  });
});
