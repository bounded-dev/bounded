import { describe, expect, test } from "vitest";
import {
  checkTicketFields, ownershipConflict, parseIssueRef, parseTicketBody, pathsOverlap, renderTicketBody, type TicketFields,
} from "./ticket-body.ts";

const FIELDS: TicketFields = {
  title: "Send invoices",
  outcome: "A customer receives an invoice.",
  acceptance: "- A sent invoice is listed\n- A failed send is retried",
  owns: ["contexts/billing/src/invoice.contract.ts", "contexts/billing/src/shared/"],
  depends: [3, 5],
  decisions: "Which currency invoices use.",
};

describe("the ticket body (ADR LEG-2026-066)", () => {
  test("renders the five sections in order and reads back its owned paths and dependencies", () => {
    const body = renderTicketBody(FIELDS);
    expect(body.split("\n").filter((l) => l.startsWith("## "))).toEqual([
      "## Outcome", "## Acceptance criteria", "## Owned paths", "## Dependencies", "## Decisions to return",
    ]);
    expect(parseTicketBody(body)).toEqual({ ok: true, owns: FIELDS.owns, depends: [3, 5] });
    expect(parseTicketBody(renderTicketBody({ ...FIELDS, depends: [] }))).toEqual({ ok: true, owns: FIELDS.owns, depends: [] });
  });

  test.each([
    ["a missing section", renderTicketBody(FIELDS).replace("## Decisions to return", "## Notes"), "lacks section(s): Decisions to return"],
    ["sections out of order", "## Acceptance criteria\n\nx\n\n## Outcome\n\nx\n\n## Owned paths\n\n- a\n\n## Dependencies\n\nNone\n\n## Decisions to return\n\nx", "out of order"],
    ["an empty section", renderTicketBody(FIELDS).replace("A customer receives an invoice.", ""), "'Outcome' section is empty"],
    ["an owned glob", renderTicketBody({ ...FIELDS, owns: ["x"] }).replace("- `x`", "- `src/**`"), "not a plain path"],
    ["a loose dependency", renderTicketBody(FIELDS).replace("- #3", "after three"), "must read '- #<issue>'"],
  ])("refuses %s", (_name, body, why) => {
    const parsed = parseTicketBody(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(why);
  });

  test.each([
    [{ title: " " }, "needs its title"],
    [{ outcome: "" }, "needs its outcome"],
    [{ acceptance: "" }, "needs its acceptance criteria"],
    [{ decisions: "" }, "needs its decisions to return"],
    [{ title: "two\nlines" }, "one line"],
    [{ owns: [] }, "at least one owned path"],
    [{ owns: ["../x"] }, "plain project-relative path"],
    [{ owns: ["/abs"] }, "plain project-relative path"],
    [{ owns: ["a/./b"] }, "plain project-relative path"],
    [{ depends: [2, 2] }, "listed twice"],
  ])("checks the fields: %j", (change, why) => {
    const check = checkTicketFields({ ...FIELDS, ...change });
    expect(check).toEqual({ ok: false, reason: expect.stringContaining(why) });
  });

  test("issue references", () => {
    expect(parseIssueRef("12")).toBe(12);
    expect(parseIssueRef("#12")).toBe(12);
    expect(parseIssueRef("0")).toBeUndefined();
    expect(parseIssueRef("12a")).toBeUndefined();
  });

  test("ownership overlaps: the same path, or one inside the other", () => {
    expect(pathsOverlap("a/b.ts", "a/b.ts")).toBe(true);
    expect(pathsOverlap("a/", "a/b.ts")).toBe(true);
    expect(pathsOverlap("a/b", "a/b/c.ts")).toBe(true);
    expect(pathsOverlap("a/b", "a/bc.ts")).toBe(false);
    expect(ownershipConflict(["x/y.ts", "a/"], ["q.ts", "a/b.ts"])).toEqual(["a/", "a/b.ts"]);
    expect(ownershipConflict(["x/y.ts"], ["x/z.ts"])).toBeUndefined();
  });
});
