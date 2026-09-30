// GENERATED from queue.contract.ts by packs/ts/scripts/scaffold-contract.ts — do not edit.
// Red-phase skeleton (TN-26-001): every value export throws NotImplementedError.
// The builder replaces this file with the real implementation.

import { NotImplementedError } from "../shared/errors.js";
import type { Money } from "../shared/money.contract.ts";

export type * from "./queue.contract.js";

export class Queue<T> {
  constructor(maxSize: number) {
    throw new NotImplementedError("Queue.constructor");
  }

  private declare readonly brand: void;
  declare readonly closed: boolean;

  push(item: T, price: Money): void {
    throw new NotImplementedError("Queue.push");
  }

  get size(): number {
    throw new NotImplementedError("Queue.size");
  }

  static create<T>(maxSize: number): Queue<T> {
    throw new NotImplementedError("Queue.create");
  }

  static get instances(): number {
    throw new NotImplementedError("Queue.instances");
  }
}

// Conformance note: classes with private/protected members are nominal in TS,
// so class conformance is by verbatim construction, not a typeof check.
