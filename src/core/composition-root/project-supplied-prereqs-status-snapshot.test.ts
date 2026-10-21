import { expect, test } from "bun:test";
import { validateProjectWiring } from "bounded/application";
import { defineConfig } from "bounded/domain";
import { prereqs } from "bounded/prereqs";
import { prereqsPortProvisions, prereqsStatusSnapshotPortProvisions } from "bounded/prereqs/adapters";

test("a project may provide prereqs' optional status snapshot to Pi but Claude's built-in provision conflicts", () => {
  const projectSnapshot = prereqsStatusSnapshotPortProvisions()[0];
  if (projectSnapshot === undefined) throw new Error("missing status snapshot fixture");
  const config = defineConfig({ packs: [prereqs], ports: [projectSnapshot] });
  expect(validateProjectWiring(config, "/project", prereqsPortProvisions()).ok).toBe(true);
  expect(validateProjectWiring(config, "/project", [...prereqsPortProvisions(), ...prereqsStatusSnapshotPortProvisions()])).toEqual({
    ok: false, error: expect.stringMatching(/bounded\/prereqs.*prerequisiteStatusSnapshots.*provided twice|prerequisiteStatusSnapshots.*bounded\/prereqs.*provided twice/),
  });
});
