import { describe, expect, test } from "bun:test";
import { ProtectedPath, writes } from "bounded/path-gate";

const rule = { match: "packages/db/**", deny: ["modify", "delete"], redirect: "Change the schema instead" };
const refused = (raw: unknown): string => {
  const parsed = ProtectedPath.parse(raw);
  return parsed.ok ? "accepted" : parsed.error;
};

describe("ProtectedPath — a deny-only rule", () => {
  test("accepts a rule and stores it explicitly: patterns tidied, deny in a fixed order without repeats, except always present, frozen", () => {
    const parsed = ProtectedPath.parse({ match: " ./packages//db/** ", deny: ["delete", "read", "delete"], redirect: " Ask the db owner ", why: " generated " });
    expect(parsed).toEqual({ ok: true, value: { match: "packages/db/**", except: [], deny: ["read", "delete"], redirect: "Ask the db owner", why: "generated" } });
    if (!parsed.ok) return;
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.deny)).toBe(true);
    expect(Object.isFrozen(parsed.value.except)).toBe(true);
  });

  test("file: true makes the rule name files only; it is stored only when true, and must be true or false", () => {
    expect(ProtectedPath.parse({ ...rule, match: ".env", file: true })).toMatchObject({ ok: true, value: { match: ".env", file: true } });
    const plain = ProtectedPath.parse({ ...rule, file: false });
    expect(plain.ok && Object.hasOwn(plain.value, "file")).toBe(false);
    expect(refused({ ...rule, file: "yes" })).toBe("A rule's file, when given, is true (its match names files, not their contents) or false");
  });

  test("`writes` is the convenience for every write: create, modify and delete", () => {
    expect(writes).toEqual(["create", "modify", "delete"]);
    expect(ProtectedPath.parse({ ...rule, deny: [...writes] })).toMatchObject({ ok: true, value: { deny: ["create", "modify", "delete"] } });
  });

  test("except holds patterns of the same rule, checked and tidied like match", () => {
    expect(ProtectedPath.parse({ ...rule, except: ["./packages/db/src/schema/**"] })).toMatchObject({ ok: true, value: { except: ["packages/db/src/schema/**"] } });
    expect(refused({ ...rule, except: "packages/db/src/**" })).toBe("A rule's except is a list of glob patterns");
    expect(refused({ ...rule, except: ["/abs/**"] })).toContain("except pattern '/abs/**' is absolute");
  });

  test("a rule is an object with match, deny and redirect, and optional except and why; nothing else", () => {
    const form = "A protected-path rule is { match, except?, deny, redirect, why?, file? }";
    expect(refused(null)).toBe(form);
    expect(refused(["packages/**"])).toBe(form);
    expect(refused({ deny: ["read"], redirect: "x" })).toBe(form);
    expect(refused({ match: "a/**", redirect: "x" })).toBe(form);
    expect(refused({ match: "a/**", deny: ["read"] })).toBe(form);
    expect(refused({ ...rule, excepts: [] })).toBe(form);
  });

  test("a bad glob is refused, naming the pattern and what is wrong", () => {
    expect(refused({ ...rule, match: "a/[b" })).toContain("match pattern 'a/[b' is not a valid glob");
    expect(refused({ ...rule, match: "a/{b" })).toContain("match pattern 'a/{b' is not a valid glob");
    expect(refused({ ...rule, match: "" })).toBe("A rule's match pattern must not be empty");
    expect(refused({ ...rule, match: "   " })).toBe("A rule's match pattern must not be empty");
    expect(refused({ ...rule, match: 42 })).toBe("A rule's match pattern must be text");
    expect(refused({ ...rule, match: "a\\b" })).toContain("contains '\\'. Separate its parts with '/'");
    expect(refused({ ...rule, match: "{a/b,c}" })).toContain("has '/' inside a group");
  });

  test("patterns are project-relative: absolute patterns and patterns with '..' are refused", () => {
    for (const match of ["/etc/**", "~/secrets", "C:/x/**"]) expect(refused({ ...rule, match })).toContain(`match pattern '${match}' is absolute`);
    for (const match of ["../x/**", "a/../../b", "a/..", "{..,a}/b"]) expect(refused({ ...rule, match })).toContain(`match pattern '${match}' uses '..'`);
  });

  test("a negated pattern is refused: carve paths out with except", () => {
    expect(refused({ ...rule, match: "!src/**" })).toContain("is negated. A rule only denies: carve paths out of it with except");
  });

  test("deny is a non-empty list of read, list, create, modify and delete", () => {
    expect(refused({ ...rule, deny: [] })).toBe("A rule's deny must name at least one of read, list, create, modify, delete");
    expect(refused({ ...rule, deny: "read" })).toBe("A rule's deny must name at least one of read, list, create, modify, delete");
    expect(refused({ ...rule, deny: ["write"] })).toBe("A rule cannot deny 'write': it denies read, list, create, modify or delete (spread `writes` for every write)");
  });

  test("redirect is non-empty text; why, when given, too", () => {
    expect(refused({ ...rule, redirect: "" })).toBe("A rule's redirect must say what to do instead");
    expect(refused({ ...rule, redirect: "  " })).toBe("A rule's redirect must say what to do instead");
    expect(refused({ ...rule, redirect: 1 })).toBe("A rule's redirect must say what to do instead");
    expect(refused({ ...rule, why: " " })).toBe("A rule's why, when given, must be non-empty text");
  });

  test("'**' inside a group, parentheses and extglobs are refused: alternatives are written with braces", () => {
    expect(refused({ ...rule, match: "a/{**,x}/c" })).toContain("match pattern 'a/{**,x}/c' has '**' inside a group");
    for (const match of ["@(**)", "+(a|aa)+(a|aa)+(b)", "(a|b)/x", "a/!(b)"]) {
      expect(refused({ ...rule, match })).toContain(`match pattern '${match}' uses parentheses. Write alternatives with braces, such as {a,b}`);
    }
  });

  test("a pattern is at most 512 characters", () => {
    expect(refused({ ...rule, match: "a".repeat(513) })).toContain("is longer than 512 characters");
    expect(ProtectedPath.parse({ ...rule, match: "a".repeat(512) }).ok).toBe(true);
  });

  test("a trailing '/' is refused: a plain name covers its contents", () => {
    expect(refused({ ...rule, match: "packages/db/" })).toContain("match pattern 'packages/db/' ends in '/'. Write 'packages/db': a name covers everything under it");
  });

  test("an except that covers the whole match is refused: the rule would deny nothing", () => {
    for (const except of ["packages/db/**", "**"]) {
      expect(refused({ ...rule, except: [except] })).toBe(`A rule's except pattern '${except}' covers its whole match 'packages/db/**', so the rule would deny nothing`);
    }
  });

  test("a rule that denies modify also denies create or delete, or a delete and create would change the file", () => {
    expect(refused({ ...rule, deny: ["modify"] })).toBe(
      "A rule that denies modify must also deny create or delete: otherwise deleting and creating the file changes it (spread `writes`)",
    );
    expect(ProtectedPath.parse({ ...rule, deny: ["modify", "create"] }).ok).toBe(true);
  });

  test("redirect and why hold no control characters and are at most 1000 characters", () => {
    expect(refused({ ...rule, redirect: "a\nb" })).toBe("A rule's redirect must not contain control characters");
    expect(refused({ ...rule, why: "a\u0000b" })).toBe("A rule's why must not contain control characters");
    expect(refused({ ...rule, redirect: "a".repeat(1001) })).toBe("A rule's redirect must be at most 1000 characters");
    expect(refused({ ...rule, why: "a".repeat(1001) })).toBe("A rule's why must be at most 1000 characters");
  });

  test("more than three wildcards in one part of a pattern are refused: matching them can take seconds", () => {
    for (const match of ["**/*a*a*a*a*b", "src/????", "a/*?*?"]) {
      expect(refused({ ...rule, match })).toContain(`match pattern '${match}' has more than three wildcards (* or ?) in one part`);
    }
    expect(ProtectedPath.parse({ ...rule, match: "**/*a*a*b/**" }).ok).toBe(true);
  });
});
