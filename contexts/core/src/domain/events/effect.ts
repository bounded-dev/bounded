import { own, readSafely, show } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./effect.contract.ts";
import { ProjectPath } from "./project-path.ts";

const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });
const KINDS = "An effect has kind read, list, write, execute, fetch, delegate or invoke";
const CHANGES: readonly Contract.Change[] = ["create", "modify", "delete"];
/** Each kind's fields, required first; a field not listed does not belong. */
const SHAPES = {
  read: { fields: ["path"], optional: [], form: "A read effect is { kind, path }" },
  list: { fields: ["root"], optional: ["filter"], form: "A list effect is { kind, root, filter? }" },
  write: { fields: ["path", "change"], optional: [], form: "A write effect is { kind, path, change }" },
  execute: { fields: ["command"], optional: [], form: "An execute effect is { kind, command }" },
  fetch: { fields: ["url"], optional: [], form: "A fetch effect is { kind, url }" },
  delegate: { fields: ["agent"], optional: [], form: "A delegate effect is { kind, agent }" },
  invoke: { fields: ["name"], optional: [], form: "An invoke effect is { kind, name }" },
} as const satisfies Record<Contract.EffectKind, { fields: readonly string[]; optional: readonly string[]; form: string }>;

const control = (text: string, allowed = ""): boolean => [...text].some((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) && !allowed.includes(c));
const isKind = (raw: unknown): raw is Contract.EffectKind => typeof raw === "string" && Object.hasOwn(SHAPES, raw);

function check(raw: unknown): Result<Contract.Effect> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return refuse(KINDS);
  const kind = own(raw, "kind");
  if (!isKind(kind)) return refuse(KINDS);
  const shape: { readonly fields: readonly string[]; readonly optional: readonly string[]; readonly form: string } = SHAPES[kind];
  const keys = Object.keys(raw).filter((key) => key !== "kind");
  const allowed = [...shape.fields, ...shape.optional];
  if (keys.some((key) => !allowed.includes(key)) || shape.fields.some((field) => !keys.includes(field))) return refuse(shape.form);
  switch (kind) {
    case "read": {
      const path = ProjectPath.parse(own(raw, "path"));
      return path.ok ? made({ kind, path: path.value }) : path;
    }
    case "list": {
      const root = ProjectPath.parse(own(raw, "root"));
      if (!root.ok) return root;
      const filter = own(raw, "filter") ?? null;
      if (filter !== null && (typeof filter !== "string" || filter.trim() === "")) return refuse("A list's filter is a non-empty file-name pattern, or null");
      return made({ kind, root: root.value, filter });
    }
    case "write": {
      const path = ProjectPath.parse(own(raw, "path"));
      if (!path.ok) return path;
      const change = own(raw, "change");
      if (!CHANGES.some((c) => c === change)) return refuse(`A write's change is create, modify or delete, not '${show(change)}'`);
      return made({ kind, path: path.value, change: change as Contract.Change });
    }
    case "execute": {
      const command = own(raw, "command");
      if (typeof command !== "string" || command.trim() === "") return refuse("An execute effect must name the command it runs");
      if (command.includes("\0")) return refuse("A command must not contain a NUL character");
      if (control(command, "\t\n\r")) return refuse("A command must not contain control characters other than tab and line breaks");
      return made({ kind, command });
    }
    case "fetch": {
      const url = own(raw, "url");
      if (typeof url !== "string" || !/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(url) || control(url)) {
        return refuse(`Fetch URL '${show(url)}' must be an absolute URL with a scheme, without spaces or control characters`);
      }
      return made({ kind, url });
    }
    case "delegate": {
      const agent = own(raw, "agent");
      if (typeof agent !== "string" || agent.trim() === "") return refuse("A delegate effect must name the agent it delegates to");
      if (control(agent)) return refuse("An agent's name must not contain control characters");
      return made({ kind, agent });
    }
    case "invoke": {
      const name = own(raw, "name");
      if (typeof name !== "string" || name.trim() === "") return refuse("An invoke effect must name the tool it invokes");
      if (control(name)) return refuse("A tool name must not contain NUL or control characters");
      return made({ kind, name });
    }
  }
}

function made(effect: Contract.Effect): Result<Contract.Effect> {
  return { ok: true, value: Object.freeze(effect) };
}

/** How messages name an effect: its kind and what it touches. */
export function describeEffect(effect: Contract.Effect): string {
  switch (effect.kind) {
    case "read":
      return `read ${effect.path}`;
    case "list":
      return effect.filter === null ? `list ${effect.root}` : `list ${effect.root} (${effect.filter})`;
    case "write":
      return `write (${effect.change}) ${effect.path}`;
    case "execute":
      return `execute \`${effect.command}\``;
    case "fetch":
      return `fetch ${effect.url}`;
    case "delegate":
      return `delegate to ${effect.agent}`;
    case "invoke":
      return `invoke ${effect.name}`;
  }
}

const parse = (raw: unknown): Result<Contract.Effect> => readSafely("An effect", () => check(raw));

export type Effect = Contract.Effect;
export const Effect: Contract.EffectFactory = { parse };
