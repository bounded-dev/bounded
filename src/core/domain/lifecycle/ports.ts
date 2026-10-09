import type { Result } from "../shared/result.ts";
import type { BasePortKey, PortKey } from "./port-key.contract.ts";
import type * as Contract from "./ports.contract.ts";
import type { portProvisionBrand, portsBrand } from "./ports.contract.ts";

function text(thrown: unknown): string {
  try {
    return String(thrown instanceof Error ? (thrown.message as unknown) : thrown);
  } catch {
    return "a value that cannot be printed";
  }
}

class PortProvisionImpl implements Contract.PortProvision {
  declare readonly __brand: "PortProvision";
  declare readonly [portProvisionBrand]: true;

  private constructor(
    readonly key: BasePortKey,
    readonly open: (projectRoot: string) => unknown,
  ) {
    Object.freeze(this);
  }

  static provide<T>(key: PortKey<T>, open: (projectRoot: string) => NoInfer<T>): Contract.PortProvision {
    return new PortProvisionImpl(key, open);
  }

  /** The provision itself when provide made it, or undefined. */
  static parse(raw: unknown): PortProvisionImpl | undefined {
    return raw instanceof PortProvisionImpl ? raw : undefined;
  }
}

class PortsImpl implements Contract.Ports {
  static readonly provide = PortProvisionImpl.provide;

  declare readonly __brand: "Ports";
  declare readonly [portsBrand]: true;
  /** Each provided port by `<owner>#<name>`, and its adapter once opened. */
  readonly #slots: Map<string, { readonly open: () => unknown; opened?: Result<unknown> }>;

  private constructor(slots: Map<string, { readonly open: () => unknown; opened?: Result<unknown> }>) {
    this.#slots = slots;
    Object.freeze(this);
  }

  static forProject(projectRoot: string, provisions: readonly Contract.PortProvision[]): Result<Contract.Ports> {
    const slots = new Map<string, { readonly open: () => unknown; opened?: Result<unknown> }>();
    for (const given of provisions) {
      const provision = PortProvisionImpl.parse(given);
      if (provision === undefined) return { ok: false, error: "A port provision is made by Ports.provide(key, open)" };
      const { key } = provision;
      if (slots.has(key.toJSON())) return { ok: false, error: `The port '${key.name}' of ${key.owner.value} is provided twice: provide each port once` };
      slots.set(key.toJSON(), { open: () => provision.open(projectRoot) });
    }
    return { ok: true, value: new PortsImpl(slots) };
  }

  get<T>(key: PortKey<T>): Result<T> {
    const slot = this.#slots.get(key.toJSON());
    if (slot === undefined) return { ok: false, error: `${key.owner.value} needs the port '${key.name}', which this host does not provide: pass it to openProject({ ports })` };
    if (slot.opened === undefined) {
      try {
        slot.opened = { ok: true, value: slot.open() };
      } catch (thrown) {
        slot.opened = { ok: false, error: `${key.owner.value} could not open the port '${key.name}': ${text(thrown)}` };
      }
    }
    // The one claim here: Ports.provide tied this adapter to the key's type
    // when it was provided, and keys meet only by owner and name.
    return slot.opened as Result<T>;
  }

  provides(key: BasePortKey): boolean {
    return this.#slots.has(key.toJSON());
  }
}

export type Ports = Contract.Ports;
export const Ports: Contract.PortsFactory = PortsImpl;
export type PortProvision = Contract.PortProvision;
