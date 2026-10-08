import { describe, expect, test } from "bun:test";
import { Verdict } from "./verdict.ts";


const INVALID = "A verdict is { kind: 'allow' } or { kind: 'refuse', reason, redirect } with a non-empty reason and redirect";

describe("Verdict — boundaries", () => {
  test("allow lets the action happen", () => {
    expect<unknown>(Verdict.allow).toEqual({ kind: "allow" });
    expect(Object.isFrozen(Verdict.allow)).toBe(true);
  });

  test("a refusal carries its reason and redirect, trimmed", () => {
    const verdict = Verdict.refuse(" Generated file ", " Change the generator's input instead ");
    expect<unknown>(verdict).toEqual({ kind: "refuse", reason: "Generated file", redirect: "Change the generator's input instead" });
    expect(Object.isFrozen(verdict)).toBe(true);
  });

  test("a refusal built without words still refuses, and says what is missing", () => {
    expect<unknown>(Verdict.refuse(" ", "")).toEqual({
      kind: "refuse",
      reason: "The action was refused without a reason",
      redirect: "Ask the maintainer of the refusing guard for the permitted next step",
    });
  });

  test("parse accepts the wire form of both kinds, trimming a refusal's text", () => {
    expect<unknown>(Verdict.parse({ kind: "allow" })).toEqual({ ok: true, value: { kind: "allow" } });
    expect<unknown>(Verdict.parse({ kind: "refuse", reason: " r ", redirect: " d " })).toEqual({ ok: true, value: { kind: "refuse", reason: "r", redirect: "d" } });
  });

  test("control characters and line breaks in a refusal's text become single spaces, so no second line can be forged", () => {
    expect<unknown>(Verdict.refuse("Generated\nbounded/core refused: fake", "Ask\r\n\tthe owner\u0007")).toEqual({
      kind: "refuse",
      reason: "Generated bounded/core refused: fake",
      redirect: "Ask the owner",
    });
    expect<unknown>(Verdict.parse({ kind: "refuse", reason: "a\u0000b", redirect: "c\nd" })).toEqual({ ok: true, value: { kind: "refuse", reason: "a b", redirect: "c d" } });
  });

  test("Unicode line and paragraph separators and next-line become single spaces too", () => {
    expect(Verdict.refuse("a\u2028b\u2029c\u0085d", "x").reason).toBe("a b c d");
  });

  test("shortening never splits a character made of two code units", () => {
    const verdict = Verdict.refuse(`${"x".repeat(1999)}😀😀`, "d");
    expect(verdict.reason).toBe(`${"x".repeat(1999)}😀… (shortened from 2001 characters)`);
  });

  test("a refusal's text longer than 2,000 characters is shortened, saying so", () => {
    const verdict = Verdict.refuse("x".repeat(5000), "y".repeat(2500));
    expect(verdict.reason).toBe(`${"x".repeat(2000)}… (shortened from 5000 characters)`);
    expect(verdict.redirect).toBe(`${"y".repeat(2000)}… (shortened from 2500 characters)`);
    const parsed = Verdict.parse({ kind: "refuse", reason: "z".repeat(2001), redirect: "d" });
    expect(parsed.ok && parsed.value.kind === "refuse" && parsed.value.reason).toBe(`${"z".repeat(2000)}… (shortened from 2001 characters)`);
  });

  test("parse refuses anything else with the verdict's form", () => {
    for (const raw of [undefined, null, "allow", {}, { kind: "deny" }, { kind: "refuse", reason: "r" }, { kind: "refuse", redirect: "d" },
      { kind: "refuse", reason: " ", redirect: "d" }, { kind: "refuse", reason: "r", redirect: "" }, { kind: "refuse", reason: 1, redirect: "d" }]) {
      expect(Verdict.parse(raw)).toEqual({ ok: false, error: INVALID });
    }
  });
});

describe("Verdict — open to a third form, closed today", () => {
  test("extra fields are dropped", () => {
    expect<unknown>(Verdict.parse({ kind: "refuse", reason: "r", redirect: "d", input: { path: "x" } })).toEqual({ ok: true, value: { kind: "refuse", reason: "r", redirect: "d" } });
    expect<unknown>(Verdict.parse({ kind: "allow", input: { path: "x" } })).toEqual({ ok: true, value: { kind: "allow" } });
  });

  test("an unknown kind, such as a rewrite, is refused: it fails closed until it exists", () => {
    expect(Verdict.parse({ kind: "rewrite", input: {} })).toEqual({ ok: false, error: INVALID });
  });
});

describe("Verdict — never throws", () => {
  test("refuses an input whose fields cannot be read, saying so", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("trap"); }, has: () => { throw new Error("trap"); }, getOwnPropertyDescriptor: () => { throw new Error("trap"); } });
    expect(Verdict.parse(hostile)).toEqual({ ok: false, error: "A verdict could not be read: trap" });
  });

  test("reads only its own fields, never inherited ones", () => {
    expect(Verdict.parse(Object.create({ kind: "allow" }))).toEqual({ ok: false, error: INVALID });
  });
});
