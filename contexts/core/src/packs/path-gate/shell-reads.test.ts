import { describe, expect, test } from "bun:test";
import { type AnyPack, Composition, contribution, corePack, definePack, dispatchEvent, packIdsFor, ToolUse, Verdict } from "bounded/domain";
import { pathGate, type ProtectedPathJSON } from "bounded/path-gate";

// The path gate's best-effort guard on shell commands that name read-protected paths.
const packId = packIdsFor("test-packs");

/** A pack, test-packs/a, that contributes `given` to the path gate's point. */
const rules = (_local: "a", ...given: ProtectedPathJSON[]): AnyPack => definePack({ id: packId("a"), dependsOn: [pathGate], contributes: [contribution(pathGate.points.protectedPaths, given)] });

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

  test("the refusal says what the command reads, then gives the rule's own refusal and redirect", () => {
    expect(shell("cat ./.env")).toMatchObject({
      kind: "refuse",
      reason: "bounded/path-gate refused execute `cat ./.env`: this command reads '.env' — the rule '.env' from test-packs/a denies read of '.env'",
      redirect: "Ask a maintainer for the value",
    });
  });

  test("a shell read is judged exactly as a file read: the same rules, exceptions, file rules and case", () => {
    const fixtures = [
      rules("a", { match: "secrets/**", except: ["secrets/README.md"], deny: ["read"], redirect: "Ask the owner", why: "credentials" }),
      rules("a", { match: "**/.env", deny: ["read"], redirect: "Ask a maintainer" }),
      rules("a", { match: "config", deny: ["read"], redirect: "Use the defaults" }),
      env,
    ];
    const paths = ["secrets/key.pem", "secrets/README.md", "SECRETS/key.pem", "api/.env", ".env", ".ENV", "config/app.json", "configs/app.json", ".envrc"];
    for (const pack of fixtures) {
      for (const path of paths) {
        const asFile = decide([pack], [{ kind: "read", path }], "read");
        const asShell = decide([pack], [{ kind: "execute", command: `cat ${path}`, cwd: null }], "shell");
        expect(asShell.kind).toBe(asFile.kind);
        if (asFile.kind === "refuse" && asShell.kind === "refuse") {
          expect(asShell.redirect).toBe(asFile.redirect);
          expect(asShell.reason.endsWith(asFile.reason.slice(asFile.reason.indexOf(": ") + 2))).toBe(true);
        }
      }
    }
  });

  test("a redirect target is a write, judged as a file write; a redirect source is a read", () => {
    const generated = rules("a", { match: "generated/**", deny: ["create", "modify", "delete"], redirect: "Change the generator's input" });
    const run = (command: string) => decide([generated], [{ kind: "execute", command, cwd: null }], "shell");
    expect(run("echo x > generated/a.ts")).toMatchObject({ kind: "refuse", redirect: "Change the generator's input" });
    expect(reason(run("echo x >> generated/a.ts"))).toStartWith("bounded/path-gate refused execute `echo x >> generated/a.ts`: this command writes 'generated/a.ts' — the rule 'generated/**' from test-packs/a denies ");
    expect(run("cat generated/a.ts > out.txt")).toBe(Verdict.allow);
    expect(shell("sort < .env").kind).toBe("refuse");
    expect(shell("echo x 2>&1")).toBe(Verdict.allow);
  });

  test("what only the shell can resolve is not guessed at: globs, variables, home and absolute paths are allowed", () => {
    for (const command of ["cat *.env", "cat $ENV_FILE", "cat $" + "{DIR}/.env", "cat ~/.env", "cat /etc/.env", "cat `echo .env`"]) expect(shell(command)).toBe(Verdict.allow);
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

  test("a command the parser cannot read is left unresolved, and allowed", () => {
    expect(shell("cat .env ${")).toBe(Verdict.allow);
    expect(shell("ls ${")).toBe(Verdict.allow);
  });

  test("a rule that does not deny read leaves shell commands alone", () => {
    const writeOnly = rules("a", { match: ".env", deny: ["create", "modify", "delete"], redirect: "Ask" });
    expect(decide([writeOnly], [{ kind: "execute", command: "cat .env", cwd: null }], "shell")).toBe(Verdict.allow);
  });
});
