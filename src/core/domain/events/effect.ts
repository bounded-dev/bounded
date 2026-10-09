import type { effectBrand } from "./effect.contract.ts";
import { own, readSafely, show } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { sameWire, wireFormOf } from "../shared/wire.ts";
import { AgentName } from "./agent-name.ts";
import { Command } from "./command.ts";
import type * as Contract from "./effect.contract.ts";
import { NamePattern } from "./name-pattern.ts";
import { ProjectPath } from "./project-path.ts";
import { ShellCommandReading } from "./shell-command-reading.ts";
import { ToolName } from "./tool-name.ts";
import { Url } from "./url.ts";

const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });
const KINDS = "An effect has kind read, list, write, execute, fetch, delegate or invoke";
const CHANGES: readonly Contract.Change[] = ["create", "modify", "delete"];
/** Each kind's fields, required first; a field not listed does not belong. */
const SHAPES = {
  read: { fields: ["path"], optional: [], form: "A read effect is { kind, path }" },
  list: { fields: ["root"], optional: ["filter"], form: "A list effect is { kind, root, filter? }" },
  write: { fields: ["path", "change"], optional: [], form: "A write effect is { kind, path, change }" },
  execute: { fields: ["command"], optional: ["cwd", "reading"], form: "An execute effect is { kind, command, cwd?, reading? }" },
  fetch: { fields: ["url"], optional: [], form: "A fetch effect is { kind, url }" },
  delegate: { fields: ["agent"], optional: ["isolated", "finishUnreported"], form: "A delegate effect is { kind, agent, isolated?, finishUnreported? }" },
  invoke: { fields: ["name"], optional: [], form: "An invoke effect is { kind, name }" },
} as const satisfies Record<Contract.EffectKind, { fields: readonly string[]; optional: readonly string[]; form: string }>;

const isKind = (raw: unknown): raw is Contract.EffectKind => typeof raw === "string" && Object.hasOwn(SHAPES, raw);

// One class per kind. Each `parse` is given an object of its kind's shape
// (Effect.parse checks the keys) and reads each field once, own fields only.

class ReadEffectImpl implements Contract.ReadEffect {
  declare readonly __brand: "Effect";
  declare readonly [effectBrand]: true;
  readonly #made = true;
  readonly kind = "read" as const;

  private constructor(readonly path: ProjectPath) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is ReadEffectImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: object): Result<Contract.ReadEffect> {
    const path = ProjectPath.parse(own(raw, "path"));
    return path.ok ? { ok: true, value: new ReadEffectImpl(path.value) } : path;
  }

  equals(other: Contract.Effect): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.ReadEffectJSON {
    return { kind: this.kind, path: this.path.value };
  }
}

class ListEffectImpl implements Contract.ListEffect {
  declare readonly __brand: "Effect";
  declare readonly [effectBrand]: true;
  readonly #made = true;
  readonly kind = "list" as const;

  private constructor(
    readonly root: ProjectPath,
    readonly filter: NamePattern | null,
  ) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is ListEffectImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: object): Result<Contract.ListEffect> {
    const root = ProjectPath.parse(own(raw, "root"));
    if (!root.ok) return root;
    const rawFilter = own(raw, "filter") ?? null;
    if (rawFilter === null) return { ok: true, value: new ListEffectImpl(root.value, null) };
    const filter = NamePattern.parse(rawFilter);
    return filter.ok ? { ok: true, value: new ListEffectImpl(root.value, filter.value) } : filter;
  }

  equals(other: Contract.Effect): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.ListEffectJSON {
    return { kind: this.kind, root: this.root.value, filter: this.filter === null ? null : this.filter.value };
  }
}

class WriteEffectImpl implements Contract.WriteEffect {
  declare readonly __brand: "Effect";
  declare readonly [effectBrand]: true;
  readonly #made = true;
  readonly kind = "write" as const;

  private constructor(
    readonly path: ProjectPath,
    readonly change: Contract.Change,
  ) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is WriteEffectImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: object): Result<Contract.WriteEffect> {
    const path = ProjectPath.parse(own(raw, "path"));
    if (!path.ok) return path;
    const change = CHANGES.find((c) => c === own(raw, "change"));
    if (change === undefined) return refuse(`A write's change is create, modify or delete, not '${show(own(raw, "change"))}'`);
    return { ok: true, value: new WriteEffectImpl(path.value, change) };
  }

  equals(other: Contract.Effect): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.WriteEffectJSON {
    return { kind: this.kind, path: this.path.value, change: this.change };
  }
}

class ExecuteEffectImpl implements Contract.ExecuteEffect {
  declare readonly __brand: "Effect";
  declare readonly [effectBrand]: true;
  readonly #made = true;
  readonly kind = "execute" as const;

  private constructor(
    readonly command: Command,
    readonly cwd: ProjectPath | null,
    readonly reading: ShellCommandReading | null,
  ) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is ExecuteEffectImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: object): Result<Contract.ExecuteEffect> {
    const command = Command.parse(own(raw, "command"));
    if (!command.ok) return command;
    const rawCwd = own(raw, "cwd") ?? null;
    const cwd = rawCwd === null ? { ok: true as const, value: null } : ProjectPath.parse(rawCwd);
    if (!cwd.ok) return cwd;
    // Absent is no reading: executes stored or sent before readings existed keep their shape.
    const rawReading = own(raw, "reading");
    const reading = rawReading === undefined ? { ok: true as const, value: null } : ShellCommandReading.parse(rawReading);
    return reading.ok ? { ok: true, value: new ExecuteEffectImpl(command.value, cwd.value, reading.value) } : reading;
  }

  equals(other: Contract.Effect): boolean {
    return sameWire(this, other);
  }

  /** The command, its directory and, only when it has one, its reading. */
  toJSON(): Contract.ExecuteEffectJSON {
    return { kind: this.kind, command: this.command.value, cwd: this.cwd === null ? null : this.cwd.value, ...(this.reading === null ? {} : { reading: this.reading.toJSON() }) };
  }
}

class FetchEffectImpl implements Contract.FetchEffect {
  declare readonly __brand: "Effect";
  declare readonly [effectBrand]: true;
  readonly #made = true;
  readonly kind = "fetch" as const;

  private constructor(readonly url: Url) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is FetchEffectImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: object): Result<Contract.FetchEffect> {
    const url = Url.parse(own(raw, "url"));
    return url.ok ? { ok: true, value: new FetchEffectImpl(url.value) } : url;
  }

  equals(other: Contract.Effect): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.FetchEffectJSON {
    return { kind: this.kind, url: this.url.value };
  }
}

class DelegateEffectImpl implements Contract.DelegateEffect {
  declare readonly __brand: "Effect";
  declare readonly [effectBrand]: true;
  readonly #made = true;
  readonly kind = "delegate" as const;

  declare readonly isolated?: true;
  declare readonly finishUnreported?: true;

  private constructor(
    readonly agent: AgentName,
    flags: { readonly isolated: boolean; readonly finishUnreported: boolean },
  ) {
    if (flags.isolated) this.isolated = true;
    if (flags.finishUnreported) this.finishUnreported = true;
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is DelegateEffectImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: object): Result<Contract.DelegateEffect> {
    const agent = AgentName.parse(own(raw, "agent"));
    if (!agent.ok) return agent;
    const flags = { isolated: false, finishUnreported: false };
    for (const field of ["isolated", "finishUnreported"] as const) {
      // Absent is false; anything else, null included, must be a boolean.
      const read = own(raw, field);
      const given = read === undefined ? false : read;
      if (typeof given !== "boolean") return refuse(`A delegate effect's ${field} must be true or false`);
      flags[field] = given;
    }
    return { ok: true, value: new DelegateEffectImpl(agent.value, flags) };
  }

  equals(other: Contract.Effect): boolean {
    return sameWire(this, other);
  }

  /** The agent and, only when true, each flag: data stored before the flags existed keeps its shape. */
  toJSON(): Contract.DelegateEffectJSON {
    return { kind: this.kind, agent: this.agent.value, ...(this.isolated === true ? { isolated: true } : {}), ...(this.finishUnreported === true ? { finishUnreported: true } : {}) };
  }
}

class InvokeEffectImpl implements Contract.InvokeEffect {
  declare readonly __brand: "Effect";
  declare readonly [effectBrand]: true;
  readonly #made = true;
  readonly kind = "invoke" as const;

  private constructor(readonly name: ToolName) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is InvokeEffectImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: object): Result<Contract.InvokeEffect> {
    const name = ToolName.parse(own(raw, "name"));
    return name.ok ? { ok: true, value: new InvokeEffectImpl(name.value) } : name;
  }

  equals(other: Contract.Effect): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.InvokeEffectJSON {
    return { kind: this.kind, name: this.name.value };
  }
}

const CLASSES = {
  read: ReadEffectImpl,
  list: ListEffectImpl,
  write: WriteEffectImpl,
  execute: ExecuteEffectImpl,
  fetch: FetchEffectImpl,
  delegate: DelegateEffectImpl,
  invoke: InvokeEffectImpl,
} as const satisfies Record<Contract.EffectKind, { made(raw: unknown): boolean; parse(raw: object): Result<Contract.Effect> }>;

function check(raw: unknown): Result<Contract.Effect> {
  for (const type of Object.values(CLASSES)) if (type.made(raw)) return check(wireFormOf(raw));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return refuse(KINDS);
  const kind = own(raw, "kind");
  if (!isKind(kind)) return refuse(KINDS);
  const shape: { readonly fields: readonly string[]; readonly optional: readonly string[]; readonly form: string } = SHAPES[kind];
  const keys = Object.keys(raw).filter((key) => key !== "kind");
  const allowed = [...shape.fields, ...shape.optional];
  if (keys.some((key) => !allowed.includes(key)) || shape.fields.some((field) => !keys.includes(field))) return refuse(shape.form);
  return CLASSES[kind].parse(raw);
}

/** How messages name an effect: its kind and what it touches. */
export function describeEffect(effect: Contract.Effect): string {
  switch (effect.kind) {
    case "read":
      return `read ${effect.path.value}`;
    case "list":
      return effect.filter === null ? `list ${effect.root.value}` : `list ${effect.root.value} (${effect.filter.value})`;
    case "write":
      return `write (${effect.change}) ${effect.path.value}`;
    case "execute":
      return effect.cwd === null ? `execute \`${effect.command.value}\`` : `execute \`${effect.command.value}\` in ${effect.cwd.value}`;
    case "fetch":
      return `fetch ${effect.url.value}`;
    case "delegate":
      return `delegate to ${effect.agent.value}`;
    case "invoke":
      return `invoke ${effect.name.value}`;
  }
}

const parse = (raw: unknown): Result<Contract.Effect> => readSafely("An effect", () => check(raw));

export type Effect = Contract.Effect;
export const Effect: Contract.EffectFactory = Object.freeze({ parse });
