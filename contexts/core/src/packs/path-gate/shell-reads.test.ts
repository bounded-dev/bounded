import { describe, expect, test } from "bun:test";
import { type AnyPack, Composition, contribution, corePack, definePack, dispatchEvent, packIdsFor, ToolUse, Verdict } from "bounded/domain";
import { pathGate, type ProtectedPath } from "bounded/path-gate";

// The path gate's best-effort guard on shell commands that name read-protected paths.
const packId = packIdsFor("test-packs");

/** A pack, test-packs/a, that contributes `given` to the path gate's point. */
const rules = (_local: "a", ...given: ProtectedPath[]): AnyPack => definePack({ id: packId("a"), dependsOn: [pathGate], contributes: [contribution(pathGate.points.protectedPaths, given)] });

/** Dispatch one tool call, its effects in wire form, over the core, the path gate and `packs`. */
function decide(packs: readonly AnyPack[], effects: object[], tool = "shell"): Verdict {
  const all = [corePack, pathGate, ...packs];
  const composed = Composition.compose(all, all);
  if (!composed.ok) throw new Error(composed.error);
  const call = ToolUse.parse({ role: null, tool, effects });
  if (!call.ok) throw new Error(call.error);
  return dispatchEvent(composed.value, call.value);
}
const reason = (verdict: Verdict): string => (verdict.kind === "refuse" ? verdict.reason : "allowed");

describe("the path gate — shell commands that name read-protected paths (best effort)", () => {
  const env = rules("a", { match: ".env", deny: ["read"], redirect: "Ask a maintainer for the value", file: true });
  const shell = (command: string, cwd: string | null = null) => decide([env], [{ kind: "execute", command, cwd }], "shell");

  test("a command naming the protected file is refused, however it spells the path", () => {
    for (const command of ["cat ./.env", "cat .env", 'less "./.env"', "less './.env'", "grep KEY .env", "source .env && run", "cp .env /tmp/x", "env $(cat .env | xargs) node app.js", "node --env-file=.env app.js"]) {
      expect(shell(command)).toMatchObject({ kind: "refuse", redirect: "Ask a maintainer for the value" });
    }
  });

  test("relative paths are resolved from the command's directory, and from a cd inside it", () => {
    expect(shell("cat ../.env", "sub").kind).toBe("refuse");
    expect(shell("cd sub && cat ../.env").kind).toBe("refuse");
    expect(shell("cat .env", "sub")).toBe(Verdict.allow);
  });

  test("the refusal says shell reads of protected files are refused, naming the rule and the path", () => {
    expect(reason(shell("cat ./.env"))).toBe(
      "bounded/path-gate refused execute `cat ./.env`: the rule '.env' from test-packs/a denies read, and this shell command names '.env': shell reads of protected files are refused",
    );
  });

  test("a name that only resembles the protected one is not refused", () => {
    expect(shell("cat .envrc")).toBe(Verdict.allow);
    expect(shell("cat .env.example")).toBe(Verdict.allow);
  });

  test("a '**'-led rule ending in a name refuses the name anywhere", () => {
    const anywhere = rules("a", { match: "**/.env", deny: ["read"], redirect: "Ask" });
    expect(decide([anywhere], [{ kind: "execute", command: "cat services/api/.env", cwd: null }], "shell").kind).toBe("refuse");
    expect(decide([anywhere], [{ kind: "execute", command: "cat .env", cwd: "services/api" }], "shell").kind).toBe("refuse");
  });

  test("redirections, command substitution and option values are read as the shell parses them", () => {
    for (const command of ["cat < .env", "sort .env > out.txt", "echo $(cat .env)", "node --env-file=.env app.js"]) expect(shell(command).kind).toBe("refuse");
    expect(shell("echo done # not cat .env")).toBe(Verdict.allow);
  });

  test("a command the parser cannot read is refused only when its text names a read-protected file", () => {
    expect(shell("cat .env ${").kind).toBe("refuse");
    expect(shell("ls ${")).toBe(Verdict.allow);
  });

  test("a rule that does not deny read leaves shell commands alone", () => {
    const writeOnly = rules("a", { match: ".env", deny: ["create", "modify", "delete"], redirect: "Ask" });
    expect(decide([writeOnly], [{ kind: "execute", command: "cat .env", cwd: null }], "shell")).toBe(Verdict.allow);
  });
});
