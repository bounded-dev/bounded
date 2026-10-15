import { describe, expect, test } from "bun:test";
import { type BasePack, Composition, contribution, corePack, definePack, dispatchEvent, packIdsFor, ToolUse, type Verdict } from "bounded/domain";
import type { RefusedToolJSON } from "../../domain/refused-tool.contract.ts";
import { refusedToolsPack } from "../../refused-tools.pack.ts";

const packId = packIdsFor("test-packs");

/** A pack, test-packs/a or test-packs/b, that contributes `given` to the refused-tools pack's point. */
function rules(local: "a" | "b", ...given: RefusedToolJSON[]): BasePack {
  const contributes = [contribution(refusedToolsPack.points.refusedTools, given)];
  return local === "a" ? definePack({ id: packId("a"), dependsOn: [refusedToolsPack], contributes }) : definePack({ id: packId("b"), dependsOn: [refusedToolsPack], contributes });
}

/** Dispatches one tool call of `tool` kind, reading README.md, over the core, the refused-tools pack and `packs`, all selected but those in `unselected`. */
function decide(packs: readonly BasePack[], tool: string, unselected: readonly BasePack[] = []): Verdict {
  const all = [corePack, refusedToolsPack, ...packs];
  const composed = Composition.compose(all, all.filter((pack) => !unselected.includes(pack)));
  if (!composed.ok) throw new Error(composed.error);
  const call = ToolUse.parse({ role: null, tool, effects: [{ kind: "read", path: "README.md" }] });
  if (!call.ok) throw new Error(call.error);
  return dispatchEvent(composed.value, call.value);
}

describe("refuseListedTools — the refused-tools pack's whole-call guard", () => {
  test("refuses a tool use of a listed kind with the first listed rule's redirect, naming the kind, the pack and the rule's pack", () => {
    const verdict = decide([rules("a", { tool: "read", redirect: "Ask a person" }), rules("b", { tool: "read", redirect: "Later" })], "read");
    expect(verdict.kind).toBe("refuse");
    if (verdict.kind !== "refuse") return;
    expect(verdict.reason).toContain("bounded-example/refused-tools refuses the tool kind 'read' (a rule from test-packs/a)");
    expect(verdict.redirect).toBe("Ask a person");
  });

  test("allows a tool use of a kind no rule lists, and allows everything with no rules", () => {
    expect(decide([rules("a", { tool: "web", redirect: "Read docs/" })], "read").kind).toBe("allow");
    expect(decide([], "web").kind).toBe("allow");
  });

  test("leaves no trace when the pack is not selected", () => {
    expect(decide([], "web", [refusedToolsPack]).kind).toBe("allow");
  });
});
