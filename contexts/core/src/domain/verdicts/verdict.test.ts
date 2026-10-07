import { describe, expect, test } from "bun:test";
import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { Verdict } from "./verdict.ts";

valueObjectLaws(
  "Verdict",
  Verdict,
  [{ kind: "allow" }, { kind: "refuse", reason: "Generated file", redirect: "Change the generator's input instead" }],
  [{ kind: "refuse", reason: "", redirect: "x" }, { kind: "refuse", reason: "x" }, { kind: "maybe" }, "allow"],
);

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

  test("parse refuses anything else with the verdict's form", () => {
    for (const raw of [undefined, null, "allow", {}, { kind: "deny" }, { kind: "refuse", reason: "r" }, { kind: "refuse", redirect: "d" },
      { kind: "refuse", reason: " ", redirect: "d" }, { kind: "refuse", reason: "r", redirect: "" }, { kind: "refuse", reason: 1, redirect: "d" }]) {
      expect(Verdict.parse(raw)).toEqual({ ok: false, error: INVALID });
    }
  });
});
