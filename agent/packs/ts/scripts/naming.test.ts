import { describe, expect, test } from "vitest";
import {
  adapterClassPrefix, adapterExportPath, adapterIndexPath, camelCase, featureKind, pascalCase, pascalWords, portRole,
  routeKey, snakeCase, toolName,
} from "./naming.ts";

// Every expectation below is a name the worked example (TN-26-012) actually
// uses; the extra rows pin the rule where the example has no instance.

describe("case conversions", () => {
  test("kebab to Pascal, camel and snake", () => {
    expect(pascalCase("project-management")).toBe("ProjectManagement");
    expect(camelCase("create-note")).toBe("createNote");
    expect(snakeCase("project-management")).toBe("project_management");
    expect(pascalCase("v2-items")).toBe("V2Items");
  });
  test.each(["", "Create-note", "create_note", "create--note", "-x", "x-", "1x"])("refuses %j", (bad) => {
    expect(() => pascalCase(bad)).toThrow(/kebab-case/);
  });
  test("pascal words", () => {
    expect(pascalWords("ProjectCsvExporter")).toEqual(["Project", "Csv", "Exporter"]);
    expect(() => pascalWords("projectExporter")).toThrow(/PascalCase/);
  });
});

describe("tRPC route keys", () => {
  test.each([
    ["notes", "create-note", "create"],
    ["notes", "list-notes", "list"],
    ["projects", "create-project", "create"],
    ["projects", "list-projects", "list"],
    ["projects", "export-projects", "export"],
    ["notes", "add-note-tag", "addTag"],
    ["notes", "archive-all", "archiveAll"],
    ["categories", "rename-category", "rename"],
    ["boxes", "open-box", "open"],
    ["order-lines", "create-order-line", "create"],
    ["order-lines", "list-order-lines", "list"],
    ["order-lines", "create-line", "createLine"],
    ["notes", "note-note", "note"],
  ])("%s/%s → %s", (area, feature, key) => {
    expect(routeKey(area, feature)).toBe(key);
  });
});

describe("other derivations", () => {
  test("MCP tool names", () => {
    expect(toolName("create-project")).toBe("create_project");
    expect(toolName("list-projects")).toBe("list_projects");
  });
  test("port roles name the file suffix and the handler parameter", () => {
    expect(portRole("CreateNoteStore")).toBe("store");
    expect(portRole("ExportProjectsStore")).toBe("store");
    expect(portRole("ProjectExporter")).toBe("exporter");
  });
  test("adapter technology names", () => {
    expect(adapterClassPrefix("in-memory")).toBe("InMemory");
    expect(adapterClassPrefix("drizzle")).toBe("Drizzle");
    expect(adapterClassPrefix("console")).toBe("Console");
    expect(adapterExportPath("in-memory")).toBe("./adapters/in-memory");
    expect(adapterIndexPath("in", "trpc")).toBe("./src/adapters/in/trpc/index.ts");
    expect(adapterIndexPath("out", "console")).toBe("./src/adapters/out/console/index.ts");
  });
  test("CQRS kind comes from the verb", () => {
    expect(featureKind("list-notes")).toBe("query");
    expect(featureKind("get-project")).toBe("query");
    expect(featureKind("create-note")).toBe("command");
    expect(featureKind("export-projects")).toBe("command");
  });
});
