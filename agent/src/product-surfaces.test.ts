import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { PRODUCT_SURFACES, selectForSurfaces, type SurfacePack } from "./product-surfaces.ts";
import { defaultSelection, describeInit, surfaceSelection } from "./project-init.ts";

// Issue #38, ADR 2026-065: init reads the product spec first. The agent maps
// the spec to product surfaces; init turns those decisions into a selection
// from the packs' own data and asks about every surface the spec left open.

const PM_NOTES = readFileSync(join(import.meta.dirname, "..", "..", "docs", "dogfood", "pm-notes-prompt.md"), "utf8");
const ALL = PRODUCT_SURFACES.map((surface) => surface.id);

/** The decisions the guidance asks for, each with the spec words it rests on. */
function fromSpec(spec: string, evidence: Readonly<Record<string, string>>): string[] {
  for (const [surface, words] of Object.entries(evidence)) {
    expect(spec.replace(/\s+/g, " "), `${surface} rests on "${words}"`).toContain(words);
  }
  return Object.keys(evidence);
}

describe("the guidance starts from the spec", () => {
  test("bare init asks for the spec before anything else and lists every surface a pack serves", () => {
    const described = describeInit() as {
      agentConversation: { openingRequest: string; guidance: string[] };
      productSurfaces: { id: string; question: string; servedBy: string[] }[];
      next: string;
    };
    expect(described.agentConversation.openingRequest).toMatch(/spec or requirements.*paste.*path to a file/);
    expect(described.agentConversation.guidance[0]).toMatch(/^Start from the product spec/);
    expect(JSON.stringify(described)).not.toContain("What kind of application");
    expect(described.productSurfaces.map((s) => s.id)).toEqual(ALL);
    // Which pack serves a surface is pack data; every surface has exactly one.
    for (const surface of described.productSurfaces) expect(surface.servedBy, surface.id).toHaveLength(1);
    expect(described.next).toContain("--surface <id>");
  });
});

describe("selection from the projects-and-notes spec", () => {
  test("the spec settles every surface, and the selection is the full stack with no question", () => {
    const needed = fromSpec(PM_NOTES, {
      "browser-ui": "In a browser:** a web app",
      "desktop": "an installable desktop app",
      "assistant-tools": "assistants such as Claude can create a project and list the projects",
      "scheduled-jobs": "A scheduled job, run in the cloud on a timer",
      "persistence": "Projects and notes must be kept safely, so nothing is lost when an app restarts",
    });
    const selection = surfaceSelection({ needed, declined: [] });
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.packs).toEqual(defaultSelection());
    // The spec never names an API for other programs; the apps need one, so it is included, not asked.
    expect(selection.surfaces.find((s) => s.id === "network-api")).toMatchObject({ state: "included" });
    expect(selection.surfaces.filter((s) => s.state === "open")).toEqual([]);
  });

  test("the order the agent lists surfaces in does not change the selection", () => {
    const forward = surfaceSelection({ needed: ["browser-ui", "desktop", "assistant-tools", "scheduled-jobs", "persistence"], declined: [] });
    const backward = surfaceSelection({ needed: ["persistence", "scheduled-jobs", "assistant-tools", "desktop", "browser-ui"], declined: [] });
    expect(backward).toEqual(forward);
  });
});

describe("a one-line description leaves surfaces open", () => {
  test("a description that settles nothing asks about every surface", () => {
    const selection = surfaceSelection({ needed: [], declined: [] });
    expect(selection.kind).toBe("open");
    if (selection.kind !== "open") return;
    expect(selection.questions.map((q) => q.id)).toEqual(ALL);
    for (const question of selection.questions) expect(question.question).toMatch(/\?$/);
  });

  test("'web app for project management' asks about each surface it leaves open, and no more", () => {
    const needed = fromSpec("web app for project management", { "browser-ui": "web app" });
    const selection = surfaceSelection({ needed, declined: [] });
    expect(selection.kind).toBe("open");
    if (selection.kind !== "open") return;
    // The web app brings its API with it; everything else is the user's call.
    expect(selection.questions.map((q) => q.id)).toEqual(["desktop", "assistant-tools", "scheduled-jobs", "persistence"]);
    const answered = surfaceSelection({ needed: [...needed, "persistence"], declined: ["desktop", "assistant-tools", "scheduled-jobs"] });
    expect(answered).toMatchObject({ kind: "selected", packs: ["ts", "ts-hexagonal", "ts-trpc", "ts-web", "ts-drizzle-postgres"] });
  });

  test("the CLI answers open surfaces with their questions and writes nothing", () => {
    const target = mkdtempSync(join(tmpdir(), "bounded-surfaces-cli-"));
    try {
      const run = spawnSync(process.execPath, [join(import.meta.dirname, "project-init-cli.ts"),
        "--cwd", target, "--host", "claude-code", "--surface", "browser-ui"], { encoding: "utf8" });
      expect(run.status).toBe(1);
      const out = JSON.parse(run.stdout) as { action: string; writes: boolean; ask: { surface: string; question: string }[] };
      expect(out.action).toBe("questions");
      expect(out.writes).toBe(false);
      expect(out.ask.map((a) => a.surface)).toEqual(["desktop", "assistant-tools", "scheduled-jobs", "persistence"]);
      expect(spawnSync("ls", ["-A", target], { encoding: "utf8" }).stdout).toBe("");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("validation against the pack data", () => {
  const packs = new Map<string, SurfacePack>([
    ["base", { dependsOnPacks: [], productSurfaces: [] }],
    ["web", { dependsOnPacks: ["base", "api"], productSurfaces: ["browser-ui"] }],
    ["api", { dependsOnPacks: ["base"], productSurfaces: ["network-api"] }],
    ["web-two", { dependsOnPacks: ["base"], productSurfaces: ["browser-ui"] }],
  ]);
  const close = (names: readonly string[]): readonly string[] => {
    const out: string[] = [];
    const add = (name: string): void => {
      if (out.includes(name)) return;
      packs.get(name)!.dependsOnPacks.forEach(add);
      out.push(name);
    };
    names.forEach(add);
    return out;
  };

  test("only surfaces some installed pack serves are asked about", () => {
    const selection = selectForSurfaces({ needed: [], declined: [] }, packs, close);
    expect(selection.kind === "open" && selection.questions.map((q) => q.id)).toEqual(["browser-ui", "network-api"]);
  });

  test.each([
    [{ needed: ["mobile"], declined: [] }, /Unknown product surface 'mobile'/],
    [{ needed: ["desktop"], declined: [] }, /No installed capability provides an installable desktop app/],
    [{ needed: ["browser-ui"], declined: [] }, /Several installed capabilities provide .*web, web-two.*--pack/],
    [{ needed: ["network-api"], declined: ["network-api"] }, /both needed and declined/],
    [{ needed: [], declined: ["browser-ui", "network-api"] }, /select no capability/],
  ])("%j is refused", (decisions, why) => {
    const selection = selectForSurfaces(decisions, packs, close);
    expect(selection.kind).toBe("refused");
    if (selection.kind === "refused") expect(selection.reason).toMatch(why);
  });

  test("an explicit pack breaks a tie between packs serving one surface", () => {
    expect(selectForSurfaces({ needed: ["browser-ui"], declined: ["network-api"] }, packs, close, ["web-two"]))
      .toMatchObject({ kind: "selected", packs: ["base", "web-two"] });
  });

  test("a pack declaring an unknown surface is refused", () => {
    const bad = new Map([...packs, ["odd", { dependsOnPacks: [], productSurfaces: ["hologram"] }]]);
    expect(selectForSurfaces({ needed: [], declined: [] }, bad, close)).toMatchObject({ kind: "refused" });
  });

  test("the core names no technology: the vocabulary is product terms only", () => {
    const core = readFileSync(join(import.meta.dirname, "product-surfaces.ts"), "utf8");
    expect(core).not.toMatch(/\bts-|react|electron|lambda|trpc|mcp|postgres|drizzle|bun\b/i);
  });
});
