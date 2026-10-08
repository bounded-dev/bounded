import { describe, expect, test } from "bun:test";
import { wireOf } from "../shared/value-object.laws.test-support.ts";
import { PackId, packIdsFor } from "./pack-id.ts";

const FORM = "must be an npm package name, '/', and lowercase words joined by hyphens, such as 'bounded/path-gate'";


describe("PackId — boundaries", () => {
  test("an id is the npm package name and the pack's local id", () => {
    const pathGate: "bounded/path-gate" = packIdsFor("bounded")("path-gate").value;
    expect(pathGate).toBe("bounded/path-gate");
    expect(packIdsFor("@acme/rules")("web-2").value).toBe("@acme/rules/web-2");
  });

  test("two ids made apart are equal by their text", () => {
    expect(packIdsFor("bounded")("core").equals(packIdsFor("bounded")("core"))).toBe(true);
    expect(packIdsFor("bounded")("core").equals(packIdsFor("bounded")("path-gate"))).toBe(false);
  });

  test("parse accepts an unscoped or scoped package with a lowercase-hyphen local id", () => {
    for (const raw of ["bounded/core", "bounded/path-gate", "@acme/rules/web-2", "my.pkg/a"]) {
      expect(wireOf(PackId.parse(raw))).toEqual({ ok: true, value: raw });
    }
  });

  test("parse refuses anything else with a reason that names it and shows the form", () => {
    expect(PackId.parse("bounded/Path-Gate")).toEqual({ ok: false, error: `Pack id 'bounded/Path-Gate' ${FORM}` });
    for (const raw of ["", "core", "bounded/", "/core", "bounded/a/b", "@acme/core", "@acme//x", "Bounded/core", "bounded/a--b", "bounded/a.b", "bounded/a_b", "bounded/-a"]) {
      expect(PackId.parse(raw).ok).toBe(false);
    }
  });

  test("an id built from an invalid package or local part is refused by parse, never thrown", () => {
    const loose = packIdsFor as unknown as (pkg: string) => (local: string) => PackId;
    expect(PackId.parse(loose("Bounded")("core")).ok).toBe(false);
    expect(PackId.parse(loose("bounded")("a/b")).ok).toBe(false);
  });

  test("parse refuses a value that is not a string", () => {
    expect(PackId.parse(7)).toEqual({ ok: false, error: "A pack id must be a string" });
  });
});
