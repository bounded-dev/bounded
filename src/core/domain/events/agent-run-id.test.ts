import { describe, expect, test } from "bun:test";
import { AgentRunId } from "./agent-run-id.ts";

const FORM = "An agent run id is non-empty text without control characters, at most 256 characters";

describe("AgentRunId", () => {
  test("an agent run id is the host's id for one agent run: non-empty text without control characters, at most 256 characters", () => {
    const parsed = AgentRunId.parse("a6eef1505a0b443a2");
    expect(parsed.ok && parsed.value.value).toBe("a6eef1505a0b443a2");
    expect(parsed.ok && parsed.value.toJSON()).toBe("a6eef1505a0b443a2");
    const again = AgentRunId.parse("a6eef1505a0b443a2");
    const other = AgentRunId.parse("ab428aba50349fc91");
    expect(parsed.ok && again.ok && parsed.value.equals(again.value)).toBe(true);
    expect(parsed.ok && other.ok && parsed.value.equals(other.value)).toBe(false);
    for (const raw of ["", "  ", "a\nb", "x".repeat(257), 42]) expect(AgentRunId.parse(raw)).toEqual({ ok: false, error: FORM });
    expect(AgentRunId.parse("x".repeat(256)).ok).toBe(true);
  });
});
