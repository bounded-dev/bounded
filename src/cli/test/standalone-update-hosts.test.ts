import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { prepareStandaloneClaudeHooks } from "../../hosts/claude-code/standalone-install.ts";
import { PROJECT_HOOK_COMMAND, withHooks } from "../../hosts/claude-code/install.ts";
import { prepareStandalonePiExtension, standalonePiLoader } from "../../hosts/pi/standalone-install.ts";

const oldExecutable = "/installed/bounded/v3.2.9/bin/bounded";
const targetExecutable = "/installed/bounded/v3.3.0/bin/bounded";
type PriorExecutableOption = { readonly recognizedPriorExecutable: string };
type PriorNodeOption = { readonly recognizedPriorNodeHooks: true };
const preparePiUpdate = prepareStandalonePiExtension as unknown as
  (root: string, executable: string, options: PriorExecutableOption) => ReturnType<typeof prepareStandalonePiExtension>;
const prepareClaudeUpdate = prepareStandaloneClaudeHooks as unknown as
  (root: string, executable: string, options: PriorExecutableOption | PriorNodeOption) => ReturnType<typeof prepareStandaloneClaudeHooks>;

test("update recognizes the exact prior standalone Pi loader and prepares only the new executable", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-update-prior-pi-"));
  try {
    const loader = join(root, ".pi", "extensions", "bounded", "index.ts");
    mkdirSync(join(root, ".pi", "extensions", "bounded"), { recursive: true });
    writeFileSync(loader, standalonePiLoader(oldExecutable));
    const prepared = await preparePiUpdate(root, targetExecutable, { recognizedPriorExecutable: oldExecutable });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.originalBytes).toBe(standalonePiLoader(oldExecutable));
    expect(prepared.value.nextBytes).toBe(standalonePiLoader(targetExecutable));
    expect(readFileSync(loader, "utf8")).toBe(standalonePiLoader(oldExecutable));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("update removes the exact previous standalone Claude hook set and preserves unrelated entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-update-prior-claude-"));
  try {
    const settings = join(root, ".claude", "settings.json");
    mkdirSync(join(root, ".claude"));
    const old = await prepareStandaloneClaudeHooks(root, oldExecutable);
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    const prior = JSON.parse(old.value.nextBytes) as { custom?: unknown; hooks: Record<string, { matcher: string; hooks: { type: string; command: string }[] }[]> };
    prior.custom = { keep: true };
    prior.hooks.PreToolUse?.unshift({ matcher: "Read", hooks: [{ type: "command", command: "echo owner" }] });
    writeFileSync(settings, `${JSON.stringify(prior)}\n`);
    const prepared = await prepareClaudeUpdate(root, targetExecutable, { recognizedPriorExecutable: oldExecutable });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const next = JSON.parse(prepared.value.nextBytes) as { custom: unknown; hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(next.custom).toEqual({ keep: true });
    expect(next.hooks.PreToolUse?.some((entry) => entry.hooks.some((hook) => hook.command === "echo owner"))).toBe(true);
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStop"]) {
      const commands = next.hooks[event]?.flatMap((entry) => entry.hooks.map((hook) => hook.command)) ?? [];
      expect(commands.filter((command) => command.includes("hook claude-code"))).toHaveLength(1);
      expect(commands.join("\n")).not.toContain(oldExecutable);
      expect(commands.join("\n")).toContain(targetExecutable);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

type ClaudeHookSettings = {
  hooks: Record<string, { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[]>;
};
const priorHookAlterations: Record<string, (settings: ClaudeHookSettings) => void> = {
  partial: (value) => { delete value.hooks.PostToolUse; },
  duplicate: (value) => { const oldEntry = value.hooks.PreToolUse?.[0]; if (oldEntry) value.hooks.PreToolUse?.push(structuredClone(oldEntry)); },
  matcher: (value) => { if (value.hooks.PreToolUse?.[0]) value.hooks.PreToolUse[0].matcher = "Read"; },
  timeout: (value) => { if (value.hooks.PreToolUse?.[0]?.hooks[0]) value.hooks.PreToolUse[0].hooks[0].timeout = 31; },
  extraField: (value) => { if (value.hooks.PreToolUse?.[0]?.hooks[0]) Object.assign(value.hooks.PreToolUse[0].hooks[0], { unexpected: true }); },
};
test("update refuses every ambiguous previous Claude hook form", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-update-ambiguous-claude-all-"));
  try {
    const settings = join(root, ".claude", "settings.json");
    mkdirSync(join(root, ".claude"));
    const generated = await prepareStandaloneClaudeHooks(root, oldExecutable);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const original = JSON.parse(generated.value.nextBytes) as ClaudeHookSettings;
    for (const [name, alter] of Object.entries(priorHookAlterations)) {
      const previous = structuredClone(original);
      alter(previous);
      const bytes = `${JSON.stringify(previous)}\n`;
      writeFileSync(settings, bytes);
      const prepared = await prepareClaudeUpdate(root, targetExecutable, { recognizedPriorExecutable: oldExecutable });
      expect(prepared.ok, name).toBe(false);
      expect(readFileSync(settings, "utf8"), name).toBe(bytes);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [name, alter] of Object.entries(priorHookAlterations).filter(([name]) => name !== "partial")) test(`update refuses ${name} previous Claude hooks`, async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-update-ambiguous-claude-"));
  try {
    const settings = join(root, ".claude", "settings.json");
    mkdirSync(join(root, ".claude"));
    const generated = await prepareStandaloneClaudeHooks(root, oldExecutable);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const previous = JSON.parse(generated.value.nextBytes) as ClaudeHookSettings;
    alter(previous);
    const bytes = `${JSON.stringify(previous)}\n`;
    writeFileSync(settings, bytes);
    const prepared = await prepareClaudeUpdate(root, targetExecutable, { recognizedPriorExecutable: oldExecutable });
    expect(prepared.ok).toBe(false);
    expect(readFileSync(settings, "utf8")).toBe(bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("update recognizes one complete published Node Claude hook set and refuses an edited command", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-update-node-claude-"));
  try {
    const settings = join(root, ".claude", "settings.json");
    mkdirSync(join(root, ".claude"));
    const generated = withHooks({}, PROJECT_HOOK_COMMAND);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const oldBytes = `${JSON.stringify(generated.value.settings)}\n`;
    writeFileSync(settings, oldBytes);
    const recognized = await prepareClaudeUpdate(root, targetExecutable, { recognizedPriorNodeHooks: true });
    expect(recognized.ok).toBe(true);
    if (recognized.ok) {
      expect(recognized.value.originalBytes).toBe(oldBytes);
      expect(recognized.value.nextBytes).not.toContain(PROJECT_HOOK_COMMAND);
      expect(recognized.value.nextBytes).toContain(targetExecutable);
    }
    expect(readFileSync(settings, "utf8")).toBe(oldBytes);
    const changed = JSON.parse(oldBytes) as ClaudeHookSettings;
    if (!changed.hooks.PreToolUse?.[0]?.hooks[0]) throw new Error("published Node hook fixture lacks PreToolUse");
    changed.hooks.PreToolUse[0].hooks[0].command += " # edited";
    const edited = `${JSON.stringify(changed)}\n`;
    expect(edited).not.toBe(oldBytes);
    writeFileSync(settings, edited);
    const refused = await prepareClaudeUpdate(root, targetExecutable, { recognizedPriorNodeHooks: true });
    expect(refused.ok).toBe(false);
    expect(readFileSync(settings, "utf8")).toBe(edited);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the published npm Pi loader is accepted byte-for-byte and an edited loader is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-update-published-pi-"));
  try {
    const loader = join(root, ".pi", "extensions", "bounded", "index.ts");
    mkdirSync(join(root, ".pi", "extensions", "bounded"), { recursive: true });
    // Fixture was generated by published bounded@3.3.0 dist/hosts/pi/host-installer.js.
    // Its npm tarball SHA-256 is f79adce31f1148d578874b35d4099ef205bf5ba72068e71eac88fab27b2aeaa3.
    const published = readFileSync(join(import.meta.dir, "fixtures", "bounded-3.3.0-pi-loader.txt"), "utf8");
    writeFileSync(loader, published);
    const recognized = await prepareStandalonePiExtension(root, targetExecutable);
    expect(recognized.ok).toBe(true);
    writeFileSync(loader, `${published}// user edit\n`);
    const edited = await prepareStandalonePiExtension(root, targetExecutable);
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.error).toMatch(/edit|unknown|preserve/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
