# pi-subagents payloads, derived from source

These fixtures stand for what pi-subagents 0.52.1 gives bounded's pi host
adapter (ADR 2026-028): the `tool_result` events of its `subagent` tool (an
asynchronous launch and synchronous results), and the payloads it emits on
pi's event bus as `subagent:async-complete`.

They are **derived from source, not captured**: each follows the lines of
pi-subagents 0.52.1 that its top-level `"_source"` field names. No
pi-subagents run produced them. The tests read them with `readFileSync`,
never import them, and delete `_source` before use.

Common values: the run id `5b1f0c6e-2d4a-4c8e-9f3b-7a1d2e3c4b5a`, its run
directory under pi-subagents' results directory in the OS temp directory,
the session's cwd `/project` and its session file `/sessions/session.jsonl`.
