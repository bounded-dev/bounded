import type { Money } from "../shared/money.contract.ts";

export declare class Queue<T> {
  constructor(maxSize: number);

  private readonly brand: void;
  readonly closed: boolean;

  push(item: T, price: Money): void;
  get size(): number;

  static create<T>(maxSize: number): Queue<T>;
  static readonly instances: number;
}
