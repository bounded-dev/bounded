import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type Config, contribution, corePack, type Decision, defineConfig, definePack, packIdsFor, type Result, Verdict, type WriteEffect } from "bounded/domain";
import type { WatchedFiles } from "../../drift/watch-shell/watch-shell.contract.ts";
import type { Clock, DecisionLog } from "../../judging/judge-event/judge-event.contract.ts";
import { OpenProjectCommand } from "./open-project.command.ts";
import type { ProjectConfigSource, ProjectDecisionLogs } from "./open-project.contract.ts";
import { OpenProjectHandler } from "./open-project.handler.ts";

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");
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

  test("a configuration source that returns no result is a configuration that cannot be loaded", async () => {
    const logs = new Logs();
    const project = await new OpenProjectHandler(source(async () => undefined as never), logs, clock).execute(command);
    expect(project.problem).toBe("the configuration source returned no result");
    expect((await project.judge(write("src/a.ts"))).kind).toBe("refuse");
    expect(logs.decisions.length).toBe(1);
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

  test("with drift watching, a shell command's changes to watched files are put back after it runs", async () => {
    const working = new Map([["generated/a.ts", "a"]]);
    const watched = (entries: Iterable<[string, string]>) => ({ ok: true as const, value: Object.fromEntries([...entries].map(([path, content]) => [path, { hash: sha256(content), size: content.length, rule: 0 }])) });
    const files: WatchedFiles = {
      hash: async () => watched(working),
      head: async () => ({ ok: true, value: "c0" }),
      committed: async () => watched([["generated/a.ts", "a"]]),
      copy: async (path) => ({ ok: true, value: { hash: sha256(working.get(path) ?? ""), size: (working.get(path) ?? "").length, content: btoa(working.get(path) ?? ""), executable: false } }),
      restore: async (path) => {
        working.set(path, "a");
        return { ok: true, value: undefined };
      },
      quarantine: async () => ({ ok: true, value: "/state/quarantine" }),
    };
    const kept = new Map<string, unknown>();
    const snapshots = { save: async (id: string, hashes: unknown) => void kept.set(id, hashes), take: async (id: string) => kept.get(id) as never };
    const watching = defineConfig({ packs: [corePack], contributes: [contribution(corePack.points.watchedPaths, [{ match: "generated/**", why: "generated", redirect: "Change the input" }])] });
    const logs = new Logs();
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: watching })), logs, clock, { drift: { forProject: () => ({ files, snapshots }) } }).execute(command);
    const shell = { kind: "tool-use", role: null, tool: "shell", effects: [{ kind: "execute", command: "make" }], callId: "c1" };
    expect((await project.judge(shell)).kind).toBe("allow");
    working.set("generated/a.ts", "tampered");
    const check = await project.afterTool({ ...shell, kind: "tool-result", ok: true });
    expect(check.restored).toBe(true);
    expect(check.message?.startsWith("This command changed protected files, and they were restored: generated/a.ts was modified — protected because")).toBe(true);
    expect(working.get("generated/a.ts")).toBe("a");
  });

  test("a tool result that cannot be read is reported, and changes nothing", async () => {
    const project = await new OpenProjectHandler(source(async () => ({ ok: true, value: config })), new Logs(), clock).execute(command);
    const check = await project.afterTool({ kind: "tool-result" });
    expect(check.changed).toEqual([]);
    expect(check.message?.startsWith("The host sent a tool result that cannot be read: ")).toBe(true);
  });

  test("records a refusal the host adapter made itself, even when the configuration is broken", async () => {
    const logs = new Logs();
    const healthy = await new OpenProjectHandler(source(async () => ({ ok: true, value: config })), logs, clock).execute(command);
    expect((await healthy.refuse({ tool: "Bash", reason: "outside", redirect: "inside" })).kind).toBe("refuse");
    const broken = await new OpenProjectHandler(source(async () => ({ ok: false, error: "no config" })), logs, clock).execute(command);
    expect((await broken.refuse({ tool: "Bash", reason: "outside", redirect: "inside" })).kind).toBe("refuse");
    expect(logs.decisions.map((d) => d.event)).toEqual(["adapter", "adapter"]);
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
