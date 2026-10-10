import { describe, expect, test } from "bun:test";
import { Command, ProjectPath, type ShellCommandReadingJSON } from "bounded/domain";
import type { ShellCommandReader } from "./read-shell-command.contract.ts";
import { ReadShellCommandHandler } from "./read-shell-command.handler.ts";

const ROOT = "/work/project";
/** A read reading's wire form: a reader's reading of a command that runs tool-a from the project root, touching no file. */
const READ: ShellCommandReadingJSON = { outcome: "read", programs: [{ name: { kind: "literal", text: "tool-a" }, arguments: [], workingDirectory: "." }], fileEffects: [], unresolved: [] };
const input = { projectRoot: ROOT, command: "tool-a x", cwd: null };
const unread = (why: string): ShellCommandReadingJSON => ({ outcome: "unread", why });
/** The error `parsed` holds; a test that expects one fails when it is ok. */
const errorOf = (parsed: { ok: true } | { ok: false; error: string }): string => (parsed.ok ? "it parsed" : parsed.error);
/** A reader that answers every command with `answer`, prepared at once. */
const answering = (answer: () => Promise<unknown>): ShellCommandReader => ({ prepare: async () => {}, read: () => answer() });

describe("ReadShellCommandHandler", () => {
  test("reads the command with the reader, given the project's root, the command and its directory, and gives the reading's wire form", async () => {
    const calls: unknown[] = [];
    let prepared = 0;
    const reader: ShellCommandReader = {
      prepare: async () => {
        prepared++;
      },
      read: async (projectRoot, command, cwd) => {
        calls.push([projectRoot, command.value, cwd === null ? null : cwd.value]);
        return READ;
      },
    };
    const handler = new ReadShellCommandHandler(reader);
    expect(await handler.read({ projectRoot: ROOT, command: "tool-a x", cwd: "app" })).toEqual(READ);
    expect(calls).toEqual([[ROOT, "tool-a x", "app"]]);
    expect(await handler.read({ projectRoot: ROOT, command: "tool-a x", cwd: null })).toEqual(READ);
    expect(calls.at(-1)).toEqual([ROOT, "tool-a x", null]);
    await handler.prepare();
    await handler.prepare();
    expect(prepared).toBe(1);
    expect(await handler.read(input)).toEqual(READ);
  });

  test("a reader that rejects leaves the command unread, saying why", async () => {
    let asked = 0;
    const handler = new ReadShellCommandHandler(
      answering(async () => {
        asked++;
        throw new Error("bounded's shell parser could not load (main.wasm is missing)");
      }),
    );
    expect(await handler.read(input)).toEqual(unread("bounded's shell parser could not load (main.wasm is missing)"));
    expect(asked).toBe(1);
  });

  test("a reader that throws instead of rejecting leaves the command unread, saying why", async () => {
    const reader: ShellCommandReader = {
      prepare: async () => {},
      read: () => {
        throw new Error("no grammar");
      },
    };
    expect(await new ReadShellCommandHandler(reader).read(input)).toEqual(unread("no grammar"));
  });

  test("a reader that does not answer within readWithinMs leaves the command unread, saying it timed out", async () => {
    const handler = new ReadShellCommandHandler(answering(() => new Promise(() => {})), { readWithinMs: 30 });
    expect(await handler.read(input)).toEqual(unread("reading the command did not finish within 30 ms (timed out)"));
  });

  test("a reading the reader gives that cannot be used leaves the command unread", async () => {
    const handler = new ReadShellCommandHandler(answering(async () => ({ outcome: "maybe" })));
    expect(await handler.read(input)).toEqual(
      unread("the shell command reader gave a reading that cannot be used: A shell command reading is { outcome: 'read', programs, fileEffects, unresolved } or { outcome: 'unread', why }"),
    );
  });

  test("a command, a directory or a project root that cannot be read as one is unread, saying why, and the reader is not asked", async () => {
    let asked = 0;
    const handler = new ReadShellCommandHandler(
      answering(async () => {
        asked++;
        return READ;
      }),
    );
    expect(await handler.read({ projectRoot: ROOT, command: "", cwd: null })).toEqual(unread(errorOf(Command.parse(""))));
    expect(await handler.read({ projectRoot: ROOT, command: "ls", cwd: "../x" })).toEqual(unread(errorOf(ProjectPath.parse("../x"))));
    expect(await handler.read({ projectRoot: "relative", command: "ls", cwd: null })).toEqual(unread("A project root is an absolute directory path, such as /home/me/project"));
    for (const raw of [null, "ls", 7, []]) expect((await handler.read(raw)).outcome).toBe("unread");
    expect(asked).toBe(0);
  });

  test("prepare never rejects: a reader whose prepare rejects, throws or never settles is let go, and reading still works", async () => {
    const failing = [
      () => Promise.reject(new Error("main.wasm is missing")),
      () => {
        throw new Error("no grammar");
      },
    ];
    for (const prepare of failing) {
      const handler = new ReadShellCommandHandler({ prepare, read: async () => READ });
      expect(await handler.prepare()).toBeUndefined();
      expect(await handler.read(input)).toEqual(READ);
    }
    let reads = 0;
    const hanging = new ReadShellCommandHandler(
      {
        prepare: () => new Promise<void>(() => {}),
        read: async () => {
          reads++;
          return READ;
        },
      },
      { prepareWithinMs: 30 },
    );
    void hanging.prepare();
    expect(await hanging.read(input)).toEqual(READ);
    expect(reads).toBe(1);
  });

  test("readWithinMs and prepareWithinMs are finite numbers of milliseconds above zero", () => {
    const reader = answering(async () => READ);
    for (const bound of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new ReadShellCommandHandler(reader, { readWithinMs: bound })).toThrow(new RangeError("readWithinMs must be a finite number of milliseconds above zero"));
      expect(() => new ReadShellCommandHandler(reader, { prepareWithinMs: bound })).toThrow(new RangeError("prepareWithinMs must be a finite number of milliseconds above zero"));
    }
    expect(ReadShellCommandHandler.DEFAULT_READ_WITHIN_MS).toBe(2000);
  });

  test("a read waits for a preparation in flight, up to prepareWithinMs, before its own readWithinMs starts", async () => {
    let settled = false;
    let readBeforeSettled = false;
    let loading: Promise<void> | undefined;
    const reader: ShellCommandReader = {
      prepare: () => {
        loading = new Promise<void>((resolve) =>
          setTimeout(() => {
            settled = true;
            resolve();
          }, 80),
        );
        return loading;
      },
      // A reader reads only once its grammar has loaded, as bounded's does.
      read: async () => {
        if (!settled) readBeforeSettled = true;
        await loading;
        return READ;
      },
    };
    const handler = new ReadShellCommandHandler(reader, { readWithinMs: 30, prepareWithinMs: 1000 });
    void handler.prepare();
    expect(await handler.read(input)).toEqual(READ);
    expect(settled).toBe(true);
    expect(readBeforeSettled).toBe(false);
    expect(ReadShellCommandHandler.DEFAULT_PREPARE_WITHIN_MS).toBe(5000);
  });

  test("a preparation a read has waited prepareWithinMs for is let go: later reads do not wait for it, the next prepare starts the reader's preparation again, and a read that times out on the old one leaves the new one waited on", async () => {
    const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    let preparations = 0;
    let settleSecond: (() => void) | undefined;
    const reader: ShellCommandReader = {
      prepare: () => {
        preparations++;
        if (preparations === 1) return new Promise<void>(() => {});
        return new Promise<void>((resolve) => {
          settleSecond = resolve;
        });
      },
      read: async () => READ,
    };
    const handler = new ReadShellCommandHandler(reader, { prepareWithinMs: 200 });
    void handler.prepare();
    void handler.prepare();
    // In flight and not yet waited out: prepared once.
    expect(preparations).toBe(1);
    const startedA = performance.now();
    const readA = handler.read(input);
    await pause(100);
    const readB = handler.read(input);
    expect(await readA).toEqual(READ);
    expect(performance.now() - startedA).toBeGreaterThanOrEqual(180);
    // A waited the first preparation out: it is let go, and the next prepare starts another.
    void handler.prepare();
    expect(preparations).toBe(2);
    // B times out on the first preparation, about 100 ms after A.
    expect(await readB).toEqual(READ);
    // B's timeout did not let go of the second preparation: a later read waits on it.
    let answeredC = false;
    const readC = handler.read(input).then((reading) => {
      answeredC = true;
      return reading;
    });
    await pause(100);
    expect(answeredC).toBe(false);
    void handler.prepare();
    expect(preparations).toBe(2);
    settleSecond?.();
    expect(await readC).toEqual(READ);
    // The second preparation has settled and is kept: a read does not wait.
    const startedD = performance.now();
    expect(await handler.read(input)).toEqual(READ);
    expect(performance.now() - startedD).toBeLessThan(50);
  });
});
