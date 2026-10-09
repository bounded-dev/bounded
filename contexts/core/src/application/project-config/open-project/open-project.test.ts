import { describe, expect, test } from "bun:test";
import { type Config, contribution, corePack, type Decision, DecisionId, DecisionTime, defineConfig, definePack, packIdsFor, portKeysFor, Ports, type ProjectOpenHandler, type Result, Verdict, type WriteEffect } from "bounded/domain";
import type { Clock, BoundedLog } from "../../bounded-log/judge-event/judge-event.contract.ts";
import { ProjectLifecycleHandler } from "../../lifecycle/project-lifecycle/project-lifecycle.handler.ts";
import { OpenProjectCommand } from "./open-project.command.ts";
import type { ProjectConfigSource, ProjectBoundedLogs, ShellCommandReader } from "./open-project.contract.ts";
import { OpenProjectHandler } from "./open-project.handler.ts";

const clock: Clock = { now: () => decisionTime("2026-10-07T12:00:00.000Z") };

/** A DecisionTime from known-good text. */
function decisionTime(text: string): DecisionTime {
  const parsed = DecisionTime.parse(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
const FIX = "Fix bounded.config.ts in the project root (see docs/configuration.md); until then every action is refused";

class Logs implements ProjectBoundedLogs {
  readonly decisions: Decision[] = [];
  readonly roots: string[] = [];
  forProject(root: string): BoundedLog {
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
    const wordsCopy = definePack({ id: packIdsFor("test-packs")("words") });
    const needsCopy = definePack({ id: packIdsFor("test-packs")("needs-copy"), dependsOn: [wordsCopy] });
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: defineConfig({ packs: [corePack, words, needsCopy] }) })), new Logs(), clock).execute(command);
    expect(project.problem).toBe(
      "its packs cannot be composed: Two different packs have the id 'test-packs/words': one listed, and one that 'test-packs/needs-copy' depends on. They are two copies of one package, or two packs given one id; make every pack use the same one",
    );
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
    const logs: ProjectBoundedLogs = {
      forProject: () => {
        throw new Error("read-only file system");
      },
    };
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: config })), logs, clock).execute(command);
    const verdict = await project.judge(write("src/a.ts"));
    expect(verdict.kind === "refuse" && verdict.reason).toBe("The guards allowed this, but the decision could not be recorded: read-only file system");
  });

  test("what packs do when a project opens runs before it is judged, given the project's root, its composition and the host's ports", async () => {
    const seen: { root: string; port: unknown; composed: boolean }[] = [];
    const gateId = packIdsFor("test-packs")("gate");
    const files = portKeysFor(gateId)<{ read(): string }>("files");
    const opening: ProjectOpenHandler = async (project, context) => {
      const port = context.ports.get(files);
      seen.push({ root: project.root, port: port.ok && port.value.read(), composed: context.composition.read(corePack.points.onProjectOpen).ok });
    };
    const gate = definePack({ id: gateId, dependsOn: [corePack], contributes: [contribution(corePack.points.onProjectOpen, [opening])], ports: { files } });
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: defineConfig({ packs: [corePack, gate] }) })), new Logs(), clock, {
      ports: [Ports.provide(files, (root) => ({ read: () => `files of ${root}` }))],
    }).execute(command);
    expect(project.problem).toBeNull();
    expect(seen).toEqual([{ root: "/work/project", port: "files of /work/project", composed: true }]);
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

  test("decisions take their ids from the ids option: the judge's, the refusing judge's and the after-tool records'", async () => {
    const parsed = DecisionId.parse("id-1");
    if (!parsed.ok) throw new Error(parsed.error);
    const id = parsed.value;
    const ids = { next: () => id };
    const gate = definePack({
      id: packIdsFor("test-packs")("recorder"),
      dependsOn: [corePack],
      contributes: [contribution(corePack.points.afterTool, [async () => ({ message: null, record: { verdict: Verdict.allow, refusedBy: null, note: "checked after" } })])],
    });
    const logs = new Logs();
    const healthy = await new OpenProjectHandler(source(async () => ({ ok: true, value: defineConfig({ packs: [corePack, gate] }) })), logs, clock, { ids }).execute(command);
    expect(await healthy.judge(write("src/a.ts"))).toBe(Verdict.allow);
    await healthy.afterTool({ kind: "tool-result", role: null, tool: "shell", effects: [{ kind: "execute", command: "make" }], callId: "c1", ok: true });
    const broken = await new OpenProjectHandler(source(async () => ({ ok: false, error: "no config" })), logs, clock, { ids }).execute(command);
    expect((await broken.judge(write("src/a.ts"))).kind).toBe("refuse");
    expect(logs.decisions.map((decision) => decision.event)).toEqual(["tool-use", "tool-result", "tool-use"]);
    expect(logs.decisions.map((decision) => decision.id.value)).toEqual(["id-1", "id-1", "id-1"]);
  });
});

describe("OpenProjectHandler — the shell command reader", () => {
  const READ = { outcome: "read", programs: [{ name: { kind: "literal", text: "tool-a" }, arguments: [], workingDirectory: "." }], fileEffects: [], unresolved: [] };
  /** A configuration whose execute guard refuses with the reading it sees, as JSON. */
  const showing = defineConfig({ packs: [corePack], contributes: [contribution(corePack.points.effectGuards.execute, [(effect) => Verdict.refuse(JSON.stringify(effect.reading), "Seen")])] });
  const shell = (callId: string) => ({ kind: "tool-use", role: null, tool: "shell", effects: [{ kind: "execute", command: "tool-a" }], callId });
  const reasonOf = (verdict: Verdict): string => (verdict.kind === "refuse" ? verdict.reason : "allowed");

  test("the shell command reader is prepared when the project opens, alongside the packs' work, and given each command with the project's root", async () => {
    let prepareStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      prepareStarted = resolve;
    });
    let openSawPrepare = false;
    const opening: ProjectOpenHandler = async () => {
      await started;
      openSawPrepare = true;
    };
    const config = defineConfig({ packs: [corePack], contributes: [contribution(corePack.points.onProjectOpen, [opening]), contribution(corePack.points.effectGuards.execute, [(effect) => Verdict.refuse(JSON.stringify(effect.reading), "Seen")])] });
    const roots: string[] = [];
    let prepared = 0;
    const reader: ShellCommandReader = {
      prepare: async () => {
        prepared++;
        prepareStarted();
      },
      read: async (projectRoot) => {
        roots.push(projectRoot);
        return READ;
      },
    };
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: config })), new Logs(), clock, { shellCommandReader: reader, prepareWithinMs: 1000 }).execute(command);
    expect(project.problem).toBeNull();
    expect(prepared).toBe(1);
    expect(openSawPrepare).toBe(true);
    expect(reasonOf(await project.judge(shell("c1")))).toBe(`bounded/project refused execute \`tool-a\`: ${JSON.stringify(READ)}`);
    expect(roots).toEqual(["/work/project"]);
  });

  test("a reader whose preparation fails or hangs does not stop the project opening", async () => {
    for (const prepare of [async () => Promise.reject(new Error("main.wasm is missing")), () => new Promise<void>(() => {})]) {
      let reads = 0;
      const reader: ShellCommandReader = {
        prepare,
        read: async () => {
          reads++;
          return READ;
        },
      };
      const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: showing })), new Logs(), clock, { shellCommandReader: reader, prepareWithinMs: 50 }).execute(command);
      expect(project.problem).toBeNull();
      expect(reasonOf(await project.judge(shell("c1")))).toEndWith(JSON.stringify(READ));
      expect(reads).toBe(1);
    }
  });

  test("a reader whose prepare throws instead of rejecting does not stop the project opening", async () => {
    const reader: ShellCommandReader = {
      prepare: () => {
        throw new Error("no grammar");
      },
      read: async () => READ,
    };
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: showing })), new Logs(), clock, { shellCommandReader: reader }).execute(command);
    expect(project.problem).toBeNull();
    expect(reasonOf(await project.judge(shell("c1")))).toEndWith(JSON.stringify(READ));
  });

  test("without prepareWithinMs, the reader's preparation is bounded by the packs' default", async () => {
    const reader: ShellCommandReader = { prepare: () => new Promise<void>(() => {}), read: async () => READ };
    const bounds: unknown[] = [];
    const real = globalThis.setTimeout;
    // Every timer set while the project opens is recorded; one of the packs' default length fires at once, so the test need not wait it out.
    const recording = ((callback: () => void, ms?: number, ...rest: unknown[]) => {
      bounds.push(ms);
      return ms === ProjectLifecycleHandler.DEFAULT_PREPARE_WITHIN_MS ? real(callback, 0) : real(callback, ms, ...rest);
    }) as typeof setTimeout;
    globalThis.setTimeout = recording;
    let problem: string | null = "not opened";
    try {
      problem = (await new OpenProjectHandler(source(async () => ({ ok: true, value: showing })), new Logs(), clock, { shellCommandReader: reader }).execute(command)).problem;
    } finally {
      globalThis.setTimeout = real;
    }
    expect(problem).toBeNull();
    expect(ProjectLifecycleHandler.DEFAULT_PREPARE_WITHIN_MS).toBe(5000);
    expect(bounds).toContain(ProjectLifecycleHandler.DEFAULT_PREPARE_WITHIN_MS);
  });
});
