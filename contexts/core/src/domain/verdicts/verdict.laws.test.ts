import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { Verdict } from "./verdict.ts";

valueObjectLaws(
  "Verdict",
  Verdict,
  [{ kind: "allow" }, { kind: "refuse", reason: "Generated file", redirect: "Change the generator's input instead" }],
  [{ kind: "refuse", reason: "", redirect: "x" }, { kind: "refuse", reason: "x" }, { kind: "maybe" }, "allow"],
);
