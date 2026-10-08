import { describe, expect, test } from "bun:test";
import { textValueLaws, valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { AgentName } from "./agent-name.ts";

valueObjectLaws("AgentName", AgentName, ["explore", "Plan reviewer"], ["", " ", "a\nb"]);
textValueLaws("AgentName", AgentName, [["explore", "explore"], ["Plan reviewer", "Plan reviewer"]]);

describe("AgentName — boundaries", () => {
  test("refuses a blank name and control characters, each with its reason", () => {
    expect(AgentName.parse(" ")).toEqual({ ok: false, error: "A delegate effect must name the agent it delegates to" });
    expect(AgentName.parse("a\nb")).toEqual({ ok: false, error: "An agent's name must not contain control characters" });
  });
});
