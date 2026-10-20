import { describe, expect, test } from "bun:test";
import { corePack, defineConfig, definePack, packIdsFor, portKeysFor, Ports } from "bounded/domain";
import { validateProjectWiring } from "./validate-project-wiring.ts";

const id = packIdsFor("test-packs")("published");
const required = portKeysFor(id)<{ read(): string }>("requiredNotes");
const optional = portKeysFor(id)<{ read(): string }>("optionalNotes");
const pack = definePack({ id, dependsOn: [corePack], ports: { requiredNotes: required }, optionalPorts: { optionalNotes: optional } });
const dependent = definePack({ id: packIdsFor("test-packs")("dependent"), dependsOn: [pack] });
const provision = Ports.provide(required, () => ({ read: () => "notes" }));
const hostPort = portKeysFor(packIdsFor("test-packs")("host"))<object>("unusedHostPort");

describe("project supplied port wiring", () => {
  test("a selected published pack receives the project's provision without opening it during validation", () => {
    let opened = 0;
    const projectProvision = Ports.provide(required, () => { opened++; return { read: () => "notes" }; });
    const config = defineConfig({ packs: [dependent], ports: [projectProvision] });
    const wired = validateProjectWiring(config, "/project", [Ports.provide(hostPort, () => ({}))]);
    expect(wired.ok).toBe(true);
    expect(opened).toBe(0);
    if (wired.ok) expect(wired.value.ports.get(required)).toEqual({ ok: true, value: { read: expect.any(Function) } });
    expect(opened).toBe(1);
  });

  test("missing and duplicate project provisions refuse before opening any factory", () => {
    const missing = validateProjectWiring(defineConfig({ packs: [dependent] }), "/project", []);
    expect(missing).toEqual({ ok: false, error: expect.stringContaining("test-packs/published needs the port 'requiredNotes'") });
    const duplicate = validateProjectWiring(defineConfig({ packs: [pack], ports: [provision, provision] }), "/project", []);
    expect(duplicate).toEqual({ ok: false, error: expect.stringContaining("requiredNotes") });
    const collision = validateProjectWiring(defineConfig({ packs: [pack], ports: [provision] }), "/project", [provision]);
    expect(collision).toEqual({ ok: false, error: expect.stringContaining("provided twice") });
  });

  test("an unselected or undeclared project port refuses with its owner and a fix", () => {
    const unselected = validateProjectWiring(defineConfig({ packs: [corePack], ports: [provision] }), "/project", []);
    expect(unselected).toEqual({ ok: false, error: expect.stringMatching(/test-packs\/published.*requiredNotes.*select|test-packs\/published.*requiredNotes.*remove/i) });
    const undeclared = validateProjectWiring(defineConfig({ packs: [pack], ports: [Ports.provide(portKeysFor(id)<object>("otherPort"), () => ({})), provision] }), "/project", []);
    expect(undeclared).toEqual({ ok: false, error: expect.stringMatching(/test-packs\/published.*otherPort.*declar|test-packs\/published.*otherPort.*remove/i) });
  });

  test("malformed and foreign-runtime provisions refuse, but an unused host provision and an optional selected port are allowed", () => {
    const malformed = validateProjectWiring(defineConfig({ packs: [pack], ports: [{} as never] }), "/project", [provision]);
    expect(malformed).toEqual({ ok: false, error: expect.stringContaining("Ports.provide") });
    const foreign = validateProjectWiring(defineConfig({ packs: [pack], ports: [{ ...provision } as never] }), "/project", [provision]);
    expect(foreign).toEqual({ ok: false, error: expect.stringContaining("Ports.provide") });
    expect(validateProjectWiring(defineConfig({ packs: [pack], ports: [provision] }), "/project", [Ports.provide(hostPort, () => ({}))]).ok).toBe(true);
    expect(validateProjectWiring(defineConfig({ packs: [pack], ports: [provision, Ports.provide(optional, () => ({ read: () => "optional" }))] }), "/project", []).ok).toBe(true);
  });

  test("untyped malformed lists and forged provision keys refuse without throwing or opening a factory", () => {
    const looseConfig = defineConfig as unknown as (spec: object) => ReturnType<typeof defineConfig>;
    const malformedList = looseConfig({ packs: [pack], ports: { notes: provision } });
    expect(() => validateProjectWiring(malformedList, "/project", [provision])).not.toThrow();
    expect(validateProjectWiring(malformedList, "/project", [provision])).toEqual({ ok: false, error: expect.stringContaining("ports") });
    let opened = 0;
    const forged = Ports.provide({} as never, () => { opened++; return {}; });
    const config = looseConfig({ packs: [pack], ports: [forged] });
    expect(() => validateProjectWiring(config, "/project", [provision])).not.toThrow();
    expect(validateProjectWiring(config, "/project", [provision])).toEqual({ ok: false, error: expect.stringContaining("port") });
    expect(opened).toBe(0);
  });

  test("the optional prereqs snapshot is supplied by a Pi-like project but collides with Claude's built-in provision", () => {
    const prereqsId = packIdsFor("test-packs")("prereqs");
    const statusSnapshot = portKeysFor(prereqsId)<{ save(): void }>("prerequisiteStatusSnapshots");
    const prereqsLike = definePack({ id: prereqsId, dependsOn: [corePack], optionalPorts: { prerequisiteStatusSnapshots: statusSnapshot } });
    const projectSnapshot = Ports.provide(statusSnapshot, () => ({ save: () => {} }));
    const config = defineConfig({ packs: [prereqsLike], ports: [projectSnapshot] });
    expect(validateProjectWiring(config, "/project", []).ok).toBe(true);
    expect(validateProjectWiring(config, "/project", [Ports.provide(statusSnapshot, () => ({ save: () => {} }))])).toEqual({
      ok: false, error: expect.stringMatching(/test-packs\/prereqs.*prerequisiteStatusSnapshots.*provided twice|prerequisiteStatusSnapshots.*test-packs\/prereqs.*provided twice/),
    });
  });
});
