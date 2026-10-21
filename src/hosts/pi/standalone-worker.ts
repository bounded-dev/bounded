import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ProjectConfigSource } from "bounded/application";
import { piExtension, type PiBusHandler, type PiHandler } from "./extension.ts";
import { composeProject, shellCommandReading } from "./composition-root.ts";

type HostEvent = "session_start" | "tool_call" | "tool_result" | "subagent:async-complete";
interface Frame { readonly protocol: 1; readonly id: number; readonly event: HostEvent; readonly payload: unknown; readonly context: { readonly cwd: string } }
interface ProjectSnapshot { readonly modulePath: string; readonly digest: string }
interface WorkerBindings<Snapshot extends ProjectSnapshot> {
  readonly capture: () => Promise<Snapshot>;
  readonly configSource: (snapshot: Snapshot) => ProjectConfigSource;
  readonly dispose: (snapshot: Snapshot) => void;
}
const maxFrameBytes = 1024 * 1024;
const events = new Set<HostEvent>(["session_start", "tool_call", "tool_result", "subagent:async-complete"]);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const block = (reason: string): { readonly block: true; readonly reason: string } => ({ block: true, reason: `bounded's Pi worker refused this call: ${reason}. Repair Bounded and start a new Pi session` });
const afterError = (reason: string, event: unknown): { readonly content: unknown[]; readonly isError: true } => ({
  content: [...(record(event) && Array.isArray(event.content) ? event.content : []),
    { type: "text", text: `bounded could not check this tool result: ${reason}. Check protected files and start a new Pi session` }],
  isError: true,
});
function requiredHandler<T>(handlers: ReadonlyMap<string, T>, name: string): T {
  const handler = handlers.get(name);
  if (handler === undefined) throw new Error(`Pi extension did not register ${name}`);
  return handler;
}

function validateEventPayload(event: HostEvent, payload: unknown): void {
  if (!record(payload)) throw new Error(`Pi ${event} payload is not an object`);
  if (event === "subagent:async-complete") return;
  if (payload.type !== event) throw new Error(`Pi ${event} payload has the wrong event type`);
  if (event === "session_start") return;
  if (typeof payload.toolCallId !== "string" || payload.toolCallId === ""
    || typeof payload.toolName !== "string" || payload.toolName === ""
    || !Object.hasOwn(payload, "input") || !record(payload.input))
    throw new Error(`Pi ${event === "tool_call" ? "tool-call" : "tool-result"} payload needs a call id, tool name and input object`);
  if (event === "tool_result" && (!Array.isArray(payload.content) || typeof payload.isError !== "boolean"))
    throw new Error("Pi tool-result payload needs content and isError");
}

function parseFrame(line: Buffer, priorId: number): Frame {
  if (line.byteLength === 0 || line.byteLength > maxFrameBytes) throw new Error("Pi request frame is empty or oversized");
  const parsed: unknown = JSON.parse(line.toString("utf8"));
  if (!record(parsed) || Object.keys(parsed).sort().join() !== "context,event,id,payload,protocol"
    || parsed.protocol !== 1 || typeof parsed.id !== "number" || !Number.isSafeInteger(parsed.id) || parsed.id <= priorId
    || typeof parsed.event !== "string" || !events.has(parsed.event as HostEvent)
    || !record(parsed.context) || Object.keys(parsed.context).join() !== "cwd"
    || typeof parsed.context.cwd !== "string" || !isAbsolute(parsed.context.cwd))
    throw new Error("Pi request frame has an invalid protocol, id, event or context");
  validateEventPayload(parsed.event as HostEvent, parsed.payload);
  return parsed as unknown as Frame;
}

function verifyProjectPin(root: string, version: string): void {
  const stateDirectory = join(root, ".bounded");
  const stateInfo = lstatSync(stateDirectory);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink())
    throw new Error("the project .bounded state directory is linked or not a directory; repair it");
  const pin = join(root, ".bounded", "version.json");
  const info = lstatSync(pin);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("the project version pin is linked or missing; repair it");
  const raw: unknown = JSON.parse(readFileSync(pin, "utf8"));
  if (!record(raw) || Object.keys(raw).sort().join() !== "schema,version"
    || raw.schema !== "bounded-project-version/1" || raw.version !== version)
    throw new Error(`the project version pin changed from ${version}; restart with the pinned release`);
}

/** The compiled process owns one Pi session and never loads packages from projected node_modules. */
export async function runStandalonePiWorker<Snapshot extends ProjectSnapshot>(root: string, version: string, bindings: WorkerBindings<Snapshot>): Promise<void> {
  if (!isAbsolute(root)) throw new Error("Pi worker project root must be absolute");
  let priorId = 0;
  let sessionDigest: string | undefined;
  let sessionStarted = false;
  let selectedSnapshot: Snapshot | undefined;
  let invalid: string | undefined;
  let handlers = new Map<string, PiHandler>();
  let busHandlers = new Map<string, PiBusHandler>();
  const acceptedCalls = new Map<string, string>();

  const frameResult = async (frame: Frame): Promise<unknown> => {
    if (frame.event === "session_start") {
      if (sessionStarted) throw new Error("a second session requires a new Pi worker");
      sessionStarted = true;
      sessionDigest = undefined;
      invalid = undefined;
      acceptedCalls.clear();
      try {
        verifyProjectPin(root, version);
        const snapshot = await bindings.capture();
        selectedSnapshot = snapshot;
        sessionDigest = snapshot.digest;
        handlers = new Map();
        busHandlers = new Map();
        const source = bindings.configSource(snapshot);
        piExtension({ projectRoot: root, load: () => composeProject(root, undefined, source), readShellCommand: shellCommandReading })({
          on(event, handler) { handlers.set(event, handler); },
          events: { on(channel, handler) { busHandlers.set(channel, handler); } },
        });
        for (const event of ["session_start", "tool_call", "tool_result"]) {
          if (!handlers.has(event)) throw new Error(`Pi extension did not register ${event}`);
        }
        if (!busHandlers.has("subagent:async-complete")) throw new Error("Pi extension did not register the async completion bus");
        await requiredHandler(handlers, "session_start")(frame.payload, frame.context);
      } catch (error) { invalid = message(error); }
      return null;
    }
    if (sessionDigest === undefined) {
      const reason = invalid ?? "the Pi session has not started";
      return frame.event === "tool_call" ? block(reason) : frame.event === "tool_result" ? afterError(reason, frame.payload) : null;
    }
    if (invalid === undefined) {
      try {
        verifyProjectPin(root, version);
        const snapshot = await bindings.capture();
        try {
          if (snapshot.digest !== sessionDigest) invalid = "the verified project snapshot changed during this Pi session";
        } finally { bindings.dispose(snapshot); }
      } catch (error) { invalid = message(error); }
    }
    if (invalid !== undefined) return frame.event === "tool_call" ? block(invalid)
      : frame.event === "tool_result" ? afterError(invalid, frame.payload) : null;
    if (frame.event === "subagent:async-complete") {
      try { await requiredHandler(busHandlers, "subagent:async-complete")(frame.payload); }
      catch (error) { invalid = `an async completion could not be recorded: ${message(error)}`; }
      return null;
    }
    const callId = record(frame.payload) ? frame.payload.toolCallId : undefined;
    if (frame.event === "tool_call") {
      if (typeof callId !== "string" || callId === "") return block("Pi's tool call has no call id");
      if (acceptedCalls.has(callId)) return block(`duplicate accepted Pi tool call id ${callId}`);
      try {
        const answer = await requiredHandler(handlers, "tool_call")(frame.payload, frame.context);
        if (answer === undefined) acceptedCalls.set(callId, sessionDigest);
        return answer ?? null;
      } catch (error) { return block(message(error)); }
    }
    if (typeof callId !== "string" || acceptedCalls.get(callId) !== sessionDigest)
      return afterError("the result does not match a guarded call in this snapshot", frame.payload);
    acceptedCalls.delete(callId);
    try { return await requiredHandler(handlers, "tool_result")(frame.payload, frame.context) ?? null; }
    catch (error) { return afterError(message(error), frame.payload); }
  };

  let buffered = Buffer.alloc(0);
  try {
    for await (const chunk of process.stdin) {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      if (buffered.byteLength > maxFrameBytes * 2) throw new Error("Pi request stream exceeds its bound");
      for (;;) {
        const newline = buffered.indexOf(10);
        if (newline < 0) break;
        const line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        const frame = parseFrame(line, priorId);
        priorId = frame.id;
        const result = await frameResult(frame);
        process.stdout.write(`${JSON.stringify({ protocol: 1, id: frame.id, event: frame.event, result })}\n`);
      }
      if (buffered.byteLength > maxFrameBytes) throw new Error("Pi request frame exceeds its bound");
    }
    if (buffered.byteLength !== 0) throw new Error("Pi request stream ended mid-frame");
  } catch (error) {
    process.stderr.write(`bounded Pi worker protocol failed: ${message(error)}\n`);
    process.exitCode = 2;
  } finally {
    if (selectedSnapshot !== undefined) bindings.dispose(selectedSnapshot);
  }
}
