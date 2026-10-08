import { describe, expect, test } from "bun:test";
import { type BasePack, Composition, contribution, corePack, definePack, dispatchEvent, packIdsFor, ToolUse, Verdict, watchedPathsOf } from "bounded/domain";
import { pathGate, type ProtectedPathJSON } from "bounded/path-gate";
import { opened } from "./shell.test-support.ts";

const packId = packIdsFor("test-packs");
const { protectedPaths } = pathGate.points;

/** A pack, test-packs/a or test-packs/b, that contributes `given` to the path gate's point. */
function rules(local: "a" | "b", ...given: ProtectedPathJSON[]): BasePack {
  const contributes = [contribution(protectedPaths, given)];
  return local === "a" ? definePack({ id: packId("a"), dependsOn: [pathGate], contributes }) : definePack({ id: packId("b"), dependsOn: [pathGate], contributes });
}

/** Dispatch one tool call, its effects in wire form, over the core, the path gate and `packs`. */
function decide(packs: readonly BasePack[], effects: object[], tool = "edit"): Verdict {
  const all = [corePack, pathGate, ...packs];
  const composed = Composition.compose(all, all);
  if (!composed.ok) throw new Error(composed.error);
  const call = ToolUse.parse({ role: null, tool, effects });
  if (!call.ok) throw new Error(call.error);
  return dispatchEvent(composed.value, call.value);
}
const read = (path: string) => ({ kind: "read", path });
const write = (path: string, change: "create" | "modify" | "delete") => ({ kind: "write", path, change });
const list = (root: string, filter: string | null = null) => ({ kind: "list", root, filter });
const reason = (verdict: Verdict): string => (verdict.kind === "refuse" ? verdict.reason : "allowed");

const db: ProtectedPathJSON = { match: "packages/db/**", deny: ["create", "modify", "delete"], redirect: "Change the schema and run the generator" };

describe("the path gate is an ordinary pack", () => {
  test("bounded/path-gate depends on the core pack and declares protectedPaths", () => {
    expect(pathGate.id.equals(packIdsFor("bounded")("path-gate"))).toBe(true);
    expect(pathGate.dependsOn).toEqual([corePack]);
    expect(protectedPaths.id).toBe("bounded/path-gate.protectedPaths");
  });

  test("without the path gate selected, its rules do not exist and nothing is judged by path", () => {
    const composed = Composition.compose([corePack, pathGate], [corePack]);
    if (!composed.ok) throw new Error(composed.error);
    const call = ToolUse.parse({ role: null, tool: "edit", effects: [write("bounded.config.ts", "modify")] });
    if (!call.ok) throw new Error(call.error);
    expect(dispatchEvent(composed.value, call.value)).toBe(Verdict.allow);
    expect(composed.value.read(protectedPaths).ok).toBe(false);
  });

  test("a rule built from untyped data is refused at composition, naming the pack, the point and the fix", () => {
    const untyped = { match: "a/**", deny: ["write"], redirect: "x" } as unknown as ProtectedPathJSON;
    const pack = definePack({ id: packId("a"), dependsOn: [pathGate], contributes: [contribution(protectedPaths, [untyped])] });
    expect(Composition.compose([corePack, pathGate, pack], [corePack, pathGate, pack])).toEqual({
      ok: false,
      error:
        "Pack 'test-packs/a' contributes an invalid value to extension point 'bounded/path-gate.protectedPaths': A rule cannot deny 'write': it denies read, list, create, modify or delete (list each write it denies: create, modify, delete). Fix the value, or remove the contribution",
    });
  });
});

describe("the path gate — reads and writes", () => {
  test("a read is refused when a rule denies read for the path, naming the path, the rule and its pack; the redirect is the rule's", () => {
    const secrets = rules("a", { match: "secrets/**", deny: ["read"], redirect: "Ask the owner for the value", why: "credentials" });
    expect(decide([secrets], [read("secrets/prod.env")])).toEqual(
      Verdict.refuse(
        "bounded/path-gate refused read secrets/prod.env: the rule 'secrets/**' from test-packs/a denies read of 'secrets/prod.env' (credentials)",
        "Ask the owner for the value",
      ),
    );
    expect(decide([secrets], [read("src/a.ts")])).toBe(Verdict.allow);
  });

  test("a rule that denies only writes lets the path be read", () => {
    expect(decide([rules("a", db)], [read("packages/db/client.ts")])).toBe(Verdict.allow);
  });

  test("a write is judged by its change: a rule denying delete refuses deletes only", () => {
    const keep = rules("a", { match: "migrations/**", deny: ["delete", "modify"], redirect: "Add a new migration" });
    expect(decide([keep], [write("migrations/001.sql", "create")])).toBe(Verdict.allow);
    expect(reason(decide([keep], [write("migrations/001.sql", "modify")]))).toBe(
      "bounded/path-gate refused write (modify) migrations/001.sql: the rule 'migrations/**' from test-packs/a denies modify of 'migrations/001.sql'",
    );
    expect(reason(decide([keep], [write("migrations/001.sql", "delete")]))).toContain("denies delete of 'migrations/001.sql'");
  });

  test("a rename (delete and create) into a protected path is refused on the create", () => {
    expect(reason(decide([rules("a", db)], [write("tmp/x.ts", "delete"), write("packages/db/x.ts", "create")]))).toContain("refused write (create) packages/db/x.ts");
  });

  test("patterns match dotfiles, and match regardless of case", () => {
    const pack = rules("a", { match: "config/**", deny: ["read"], redirect: "Read the docs" });
    expect(reason(decide([pack], [read("config/.env")]))).toContain("denies read of 'config/.env'");
    expect(reason(decide([pack], [read("Config/Prod.json")]))).toContain("denies read of 'Config/Prod.json'");
  });

  test("a read of a file is judged by the file alone: a deeper rule does not refuse a sibling", () => {
    const pack = rules("a", { match: "packages/*/secret.env", deny: ["read"], redirect: "Ask the owner" });
    expect(decide([pack], [read("packages/a.json")])).toBe(Verdict.allow);
  });
});

describe("the path gate — names and directories", () => {
  test("a rule ending in a literal name covers everything under that name", () => {
    const db = rules("a", { match: "packages/db", deny: ["create", "modify", "delete"], redirect: "Leave the database package alone" });
    expect(reason(decide([db], [write("packages/db/src/x.ts", "modify")]))).toContain("the rule 'packages/db' from test-packs/a denies modify of 'packages/db/src/x.ts'");
    expect(decide([db], [write("packages/dbx/x.ts", "modify")])).toBe(Verdict.allow);
    expect(decide([db], [read("packages/db/src/x.ts")])).toBe(Verdict.allow);
  });

  test("a rule ending in a glob covers only the paths it matches", () => {
    const keys = rules("a", { match: "keys/*.pem", deny: ["modify", "delete"], redirect: "Rotate keys with the tool" });
    expect(decide([keys], [write("keys/a.pem/notes.txt", "modify")])).toBe(Verdict.allow);
    expect(decide([keys], [write("keys/a.pem", "modify")]).kind).toBe("refuse");
  });

  test("deleting a directory that could hold a path a rule denies delete for is refused", () => {
    expect(reason(decide([rules("a", db)], [write("packages", "delete")]))).toBe(
      "bounded/path-gate refused write (delete) packages: the rule 'packages/db/**' from test-packs/a denies delete, and deleting 'packages' could delete a path it matches",
    );
    expect(decide([rules("a", db)], [write("packages/db", "delete")]).kind).toBe("refuse");
    expect(decide([rules("a", db)], [write("packages/db", "delete"), write("packages/db2", "create")]).kind).toBe("refuse");
    expect(decide([rules("a", db)], [write("docs", "delete"), write("packages", "modify")])).toBe(Verdict.allow);
    expect(decide([rules("a", { ...db, except: ["packages/db/src/schema/**"] })], [write("packages/db/src/schema", "delete")])).toBe(Verdict.allow);
  });

  test("deleting the project root is always refused", () => {
    expect(decide([], [write(".", "delete")]).kind).toBe("refuse");
  });
});

describe("the path gate — except carves paths out of its own rule only", () => {
  const generated: ProtectedPathJSON = { ...db, except: ["packages/db/src/schema/**"] };

  test("a path in the rule's except is not denied by that rule", () => {
    expect(decide([rules("a", generated)], [write("packages/db/src/schema/users.ts", "modify")])).toBe(Verdict.allow);
    expect(reason(decide([rules("a", generated)], [write("packages/db/src/client.ts", "modify")]))).toContain("the rule 'packages/db/**' from test-packs/a");
  });

  test("an exception never reaches another rule, from the same pack or another", () => {
    const schemaKept: ProtectedPathJSON = { match: "**/schema/**", deny: ["delete"], redirect: "Deprecate the table instead" };
    expect(decide([rules("a", generated, schemaKept)], [write("packages/db/src/schema/users.ts", "modify")])).toBe(Verdict.allow);
    expect(reason(decide([rules("a", generated, schemaKept)], [write("packages/db/src/schema/users.ts", "delete")]))).toContain("the rule '**/schema/**' from test-packs/a");
    expect(reason(decide([rules("a", generated), rules("b", schemaKept)], [write("packages/db/src/schema/users.ts", "delete")]))).toContain(
      "the rule '**/schema/**' from test-packs/b",
    );
  });
});

describe("the path gate — a denial always wins", () => {
  test("rules from several packs all apply: any rule that denies refuses", () => {
    const readOnly = rules("a", { match: "docs/**", deny: ["read"], redirect: "Use the published docs" });
    const frozen = rules("b", { match: "docs/adr/**", deny: ["modify", "delete"], redirect: "Write a superseding ADR" });
    expect(decide([readOnly, frozen], [write("docs/guide.md", "modify")])).toBe(Verdict.allow);
    expect(decide([readOnly, frozen], [write("docs/adr/001.md", "modify")])).toEqual(
      Verdict.refuse("bounded/path-gate refused write (modify) docs/adr/001.md: the rule 'docs/adr/**' from test-packs/b denies modify of 'docs/adr/001.md'", "Write a superseding ADR"),
    );
  });

  test("when several rules deny, the first in pack order is named, whatever order the packs were listed in", () => {
    const first = rules("a", { match: "src/**", deny: ["modify", "delete"], redirect: "first" });
    const second = rules("b", { match: "src/core/**", deny: ["modify", "delete"], redirect: "second" });
    expect(decide([second, first], [write("src/core/x.ts", "modify")])).toMatchObject({ kind: "refuse", redirect: "first" });
    expect(decide([first, second], [write("src/core/x.ts", "modify")])).toMatchObject({ kind: "refuse", redirect: "first" });
  });

  test("one refused effect refuses the whole call", () => {
    expect(decide([rules("a", db)], [read("src/a.ts"), write("src/a.ts", "modify"), write("packages/db/x.ts", "modify")]).kind).toBe("refuse");
  });
});

describe("the path gate — listing is judged conservatively", () => {
  const hidden = (match: string, except: string[] = []): BasePack => rules("a", { match, except, deny: ["list"], redirect: "Do not look there" });

  test("a listing whose root is the protected path, inside it or above it is refused, naming the root and the rule", () => {
    expect(reason(decide([hidden("packages/db/**")], [list("packages/db")]))).toBe(
      "bounded/path-gate refused list packages/db: the rule 'packages/db/**' from test-packs/a denies list, and listing 'packages/db' could reveal a path it matches",
    );
    expect(decide([hidden("packages/db/**")], [list("packages/db/src")]).kind).toBe("refuse");
    expect(decide([hidden("packages/db/**")], [list("packages")]).kind).toBe("refuse");
    expect(decide([hidden("packages/db/**")], [list(".")]).kind).toBe("refuse");
    expect(decide([hidden("**/.env")], [list("apps/web")]).kind).toBe("refuse");
  });

  test("a listing that cannot reach the protected paths is allowed", () => {
    expect(decide([hidden("packages/db/**")], [list("docs")])).toBe(Verdict.allow);
    expect(decide([hidden("packages/db/**")], [list("packages/dbx")])).toBe(Verdict.allow);
    expect(decide([hidden("packages/*/secrets/**")], [list("packages/a/src")])).toBe(Verdict.allow);
  });

  test("a filter excludes a protected path only provably: a literal name, or disjoint literal suffixes or prefixes", () => {
    expect(decide([hidden("config/*.pem")], [list("config", "*.ts")])).toBe(Verdict.allow);
    expect(decide([hidden("config/*.pem")], [list("config", "*.pem.bak")])).toBe(Verdict.allow);
    expect(decide([hidden("config/*.pem")], [list("config", "server.ts")])).toBe(Verdict.allow);
    expect(decide([hidden("config/key*")], [list("config", "id*")])).toBe(Verdict.allow);
    expect(reason(decide([hidden("config/*.pem")], [list("config", "*m")]))).toContain("listing 'config' could reveal a path it matches");
    expect(decide([hidden("config/*.pem")], [list("config", "server.PEM")]).kind).toBe("refuse");
    expect(decide([hidden("config/key*")], [list("config", "k*")]).kind).toBe("refuse");
    expect(decide([hidden("config/key*")], [list("config", "*.ts")]).kind).toBe("refuse");
    expect(decide([hidden("secrets/**")], [list(".", "*.md")]).kind).toBe("refuse");
  });

  test("a rule ending in a literal name covers that name's contents, so no filter rules it out", () => {
    expect(decide([hidden("config/.env")], [list("config", "*.ts")]).kind).toBe("refuse");
  });

  test("a filter with '/' or '**' in it proves nothing", () => {
    for (const filter of ["sub/*.ts", "{a/b,*.ts}", "**/*.ts", "*.ts/", "**"]) {
      expect(decide([hidden("config/*.pem")], [list("config", filter)]).kind).toBe("refuse");
    }
  });

  test("a part with '**' anywhere in it may span parts of a path", () => {
    expect(decide([hidden("a/b**/c")], [list("a/bz/d")]).kind).toBe("refuse");
    expect(decide([hidden("a/b**/c")], [list("z/bz/d")])).toBe(Verdict.allow);
  });

  test("a listing refusal composes its redirect: list elsewhere or filter it out, then the rule's own redirect", () => {
    expect(decide([hidden("secrets/**")], [list(".")])).toMatchObject({
      kind: "refuse",
      redirect: "List a narrower path (not the whole project) that cannot reach 'secrets/**' — Do not look there",
    });
  });

  test("an except helps a listing only when it covers everything under the root", () => {
    const db = hidden("packages/db/**", ["packages/db/src/schema/**"]);
    expect(decide([db], [list("packages/db/src/schema")])).toBe(Verdict.allow);
    expect(decide([db], [list("packages/db/src/schema/tables")])).toBe(Verdict.allow);
    expect(decide([db], [list("packages/db/src")]).kind).toBe("refuse");
  });

  test("a rule that does not deny list leaves listings alone", () => {
    expect(decide([rules("a", db)], [list("packages/db")])).toBe(Verdict.allow);
  });

  test("a content search (a list and a read over the same root) is refused when it could read a path a rule denies read for", () => {
    const keys = rules("a", { match: "src/keys/**", deny: ["read"], redirect: "Search elsewhere" });
    expect(reason(decide([keys], [list("src", "*.ts"), read("src")], "search"))).toBe(
      "bounded/path-gate refused read src: the rule 'src/keys/**' from test-packs/a denies read, and searching 'src' could read a path it matches",
    );
    expect(decide([keys], [list("docs"), read("docs")], "search")).toBe(Verdict.allow);
    expect(decide([keys], [list("src"), read("src")], "search")).toMatchObject({
      kind: "refuse",
      redirect: "Search a root outside 'src/keys/**' — Search elsewhere",
    });
  });

  test("a search is recognised whatever the case of its root", () => {
    const keys = rules("a", { match: "src/keys/**", deny: ["read"], redirect: "Search elsewhere" });
    expect(decide([keys], [list("SRC"), read("src")], "search").kind).toBe("refuse");
  });
});

describe("the path gate — rules that name files only", () => {
  const env = (match: string, deny: ProtectedPathJSON["deny"] = ["read", "list"]) => rules("a", { match, deny, redirect: "Ask for the values you need", file: true });

  test("a file rule covers exactly the paths it matches, not what is under them", () => {
    expect(decide([env(".env")], [read(".env")]).kind).toBe("refuse");
    expect(decide([env(".ENV")], [read(".env")]).kind).toBe("refuse");
    expect(decide([env(".env")], [read(".env/inner")])).toBe(Verdict.allow);
    expect(decide([env(".env")], [read("src/.env")])).toBe(Verdict.allow);
  });

  test("a filter that cannot match a file rule's name keeps a listing or search of the whole project away from it", () => {
    expect(decide([env(".env")], [list(".", "*.ts")])).toBe(Verdict.allow);
    expect(decide([env(".env")], [list(".", "*.ts"), read(".")], "search")).toBe(Verdict.allow);
    expect(decide([env(".env")], [list(".", ".env*")]).kind).toBe("refuse");
    expect(decide([env(".env")], [list(".", "*")]).kind).toBe("refuse");
    expect(decide([env("**/.env")], [list("src", "*.ts")])).toBe(Verdict.allow);
  });

  test("refusing a listing or search of the whole project says to narrow it or filter the name out, never to look outside the name", () => {
    expect(decide([env(".env")], [list(".")])).toMatchObject({
      kind: "refuse",
      redirect: "List a narrower path (not the whole project), or give a filter that cannot match '.env' — Ask for the values you need",
    });
    expect(decide([env(".env", ["read"])], [list("."), read(".")], "search")).toMatchObject({
      kind: "refuse",
      redirect: "Search a narrower path (not the whole project), or give a filter that cannot match '.env' — Ask for the values you need",
    });
  });

  test("a file rule that denies writes is watched as the file alone", () => {
    const all = [corePack, pathGate, rules("a", { match: ".env", deny: ["create", "modify", "delete"], redirect: "Ask", file: true })];
    const composed = Composition.compose(all, all);
    if (!composed.ok) throw new Error(composed.error);
    const watched = watchedPathsOf(composed.value);
    expect(watched.ok && watched.value.map(({ rule }) => rule.match).filter((match) => match.includes(".env"))).toEqual([".env"]);
  });
});

describe("the path gate — limits and honest redirects", () => {
  test("a three-wildcard part stays fast against a long name", () => {
    const slow = rules("a", { match: "**/*a*a*b", deny: ["read"], redirect: "x" });
    const started = performance.now();
    expect(decide([slow], [read(`x/${"a".repeat(255)}`)])).toBe(Verdict.allow);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("when no filter or root can avoid a '**'-led rule ending in a name, the redirect says so", () => {
    const env = rules("a", { match: "**/.env", deny: ["read", "list"], redirect: "Ask a maintainer" });
    const unreadable = rules("a", { match: "**/.env", deny: ["read"], redirect: "Ask a maintainer" });
    expect(decide([unreadable], [list("src", "*.ts"), read("src")], "search")).toMatchObject({
      kind: "refuse",
      redirect: "No search can avoid '**/.env'; read the files you need directly, or ask a person — Ask a maintainer",
    });
    expect(decide([env], [list("src", "*.ts")])).toMatchObject({
      kind: "refuse",
      redirect: "No listing can avoid '**/.env'; name the files you need directly, or ask a person — Ask a maintainer",
    });
  });
});

describe("the path gate — what it does not judge in this slice", () => {
  test("fetch, delegate and invoke are not judged by path, nor a shell command naming no protected path", async () => {
    const everything = rules("a", { match: "packages/**", deny: ["read", "list", "create", "modify", "delete"], redirect: "Nothing" });
    const decideOpened = await opened([everything]);
    expect(
      decideOpened(
        [
          { kind: "execute", command: "rm -rf docs/old" },
          { kind: "fetch", url: "https://example.com" },
          { kind: "delegate", agent: "reviewer" },
          { kind: "invoke", name: "mcp__db__migrate" },
        ],
        "other",
      ),
    ).toBe(Verdict.allow);
  });
});

describe("the path gate — built-in protection of its own configuration", () => {
  test("its own rules protect bounded.config.* and .bounded/** from every write, contributed by bounded/path-gate", () => {
    const composed = Composition.compose([corePack, pathGate], [corePack, pathGate]);
    if (!composed.ok) throw new Error(composed.error);
    const entries = composed.value.entries(protectedPaths);
    expect(entries.ok && entries.value.map(({ fromPackId, value }) => [fromPackId.value, value.match, value.deny])).toEqual([
      ["bounded/path-gate", "**/bounded.config.*", ["create", "modify", "delete"]],
      ["bounded/path-gate", ".bounded/**", ["create", "modify", "delete"]],
    ]);
  });

  test("an agent cannot write its own guardrails", () => {
    for (const change of ["create", "modify", "delete"] as const) {
      expect(reason(decide([], [write("bounded.config.ts", change)]))).toBe(
        `bounded/path-gate refused write (${change}) bounded.config.ts: the rule '**/bounded.config.*' from bounded/path-gate denies ${change} of 'bounded.config.ts' (the project's guardrails are changed by people, not by agents)`,
      );
    }
    expect(decide([], [write("bounded.config.js", "create")]).kind).toBe("refuse");
    expect(decide([], [write(".bounded/guard-log.jsonl", "modify")]).kind).toBe("refuse");
    expect(decide([], [write(".bounded/state/x.json", "delete")]).kind).toBe("refuse");
  });

  test("the configuration can still be read, and other files written", () => {
    expect(decide([], [read("bounded.config.ts"), read(".bounded/guard-log.jsonl"), write("src/config.ts", "modify")])).toBe(Verdict.allow);
  });

  test("a configuration file is protected at any depth", () => {
    expect(decide([], [write("packages/app/bounded.config.ts", "modify")]).kind).toBe("refuse");
  });

  test("no pack's except can carve out the built-in protection", () => {
    const loose = rules("a", { match: "**", except: ["bounded.config.ts"], deny: ["read"], redirect: "x" });
    expect(decide([loose], [write("bounded.config.ts", "modify")]).kind).toBe("refuse");
  });
});
