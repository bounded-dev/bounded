import { describe, expect, test } from "bun:test";
import { ProtectedPath, writes } from "bounded/path-gate";

const rule = { match: "packages/db/**", deny: ["modify"], redirect: "Change the schema instead" };
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
    const form = "A protected-path rule is { match, except?, deny, redirect, why? }";
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
});
