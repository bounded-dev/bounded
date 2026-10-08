import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { declarationOnly } from "./declaration-only.ts";

// TN-26-001 architect zone rule: contracts are declaration-only —
// "no function bodies; no concrete infra imports".
// Which files this applies to (**/*.contract.ts) is gate wiring, not the rule.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("declaration-only", declarationOnly, {
  valid: [
    // --- the declaration vocabulary ---
    "export interface Order { id: string; total: number; }",
    "export type Status = 'open' | 'paid';",
    "type Internal = string;", // unexported types are fine
    "export declare function createOrder(input: NewOrder): Order;",
    "export declare const DEFAULT_CURRENCY: string;",
    // the contract-owns-the-name pair (ADR LEG-2026-059)
    'import type { Result } from "../shared/result.ts";\nexport interface OrderId { readonly __brand: "OrderId"; readonly value: string; }\nexport interface OrderIdFactory { parse(raw: unknown): Result<OrderId>; }',
    // overloads: every signature needs its own `declare`, same as a single one
    "export declare function find(id: string): Order | undefined;\nexport declare function find(id: number): Order | undefined;",
    "export default interface Config { debug: boolean; }",
    "export {};",
    "",
    // --- type-only module graph ---
    "import type { Money } from '../shared/money.contract.js';\nexport interface Line { price: Money; }",
    "import { type A, type B } from './x.contract.js';\nexport type T = A & B;",
    "export type { Order } from './order.contract.js';",
    "export type * from './order.contract.js';",
    // bare local re-export: the binding is checked at its own declaration
    "interface Foo { a: string }\nexport { Foo };",
    "export { type Bar } from './bar.contract.js';",
    // --- ambient namespaces, type members only ---
    "export declare namespace Orders { type Id = string; interface Repo { get(id: Id): Order; } }",
    "declare global { interface Window { orderCount: number; } }",
  ],

  invalid: [
    // --- the retired declare-class contract form (ADR LEG-2026-059) ---
    {
      code: "export declare class OrderId { readonly value: string; }",
      errors: [{ messageId: "retiredDeclareClass", data: { name: "OrderId" } }],
    },
    {
      code: 'export declare class Currency {\n  private readonly __brand: "Currency";\n  private constructor();\n  readonly code: string;\n  static parse(raw: unknown): Currency | undefined;\n}',
      errors: [{ messageId: "retiredDeclareClass", data: { name: "Currency" } }],
    },
    // unexported, and inside an ambient namespace: still a class in a contract
    {
      code: "declare class Repo { get(id: string): string; }",
      errors: [{ messageId: "retiredDeclareClass", data: { name: "Repo" } }],
    },
    {
      code: "export declare namespace Orders { class Repo { get(id: string): string; } }",
      errors: [{ messageId: "classBody", data: { name: "Repo" } }],
    },
    // --- function bodies (TN: no function bodies) ---
    {
      code: "export function createOrder(input: NewOrder): Order { return input as Order; }",
      errors: [{ messageId: "functionBody", data: { name: "createOrder" } }],
    },
    {
      code: "export default function () { return 1; }",
      errors: [{ messageId: "defaultValue" }],
    },
    {
      code: "function helper() { return 42; }",
      errors: [{ messageId: "functionBody", data: { name: "helper" } }],
    },
    // --- bodiless signature missing `declare` (the live dogfood bug: tsc
    // requires `declare` on a bodiless function or it's TS2391 "Function
    // implementation is missing or not immediately following the
    // declaration" — a contract that fails to compile) ---
    {
      code: "export function parse(s: string): Order;",
      errors: [{ messageId: "missingDeclare", data: { name: "parse" } }],
    },
    {
      code: "function helper(s: string): Order;",
      errors: [{ messageId: "missingDeclare", data: { name: "helper" } }],
    },
    // one bare signature poisons an otherwise-declared overload set — every
    // signature needs its own `declare`
    {
      code: "export declare function find(id: string): Order | undefined;\nexport function find(id: number): Order | undefined;",
      errors: [{ messageId: "missingDeclare", data: { name: "find" } }],
    },
    // --- value bindings emit runtime code ---
    {
      code: "export const TAX_RATE = 0.2;",
      errors: [{ messageId: "valueBinding", data: { name: "TAX_RATE" } }],
    },
    {
      code: "export const createOrder = (input: NewOrder): Order => input as Order;",
      errors: [{ messageId: "valueBinding", data: { name: "createOrder" } }],
    },
    {
      code: "let counter: number;",
      errors: [{ messageId: "valueBinding", data: { name: "counter" } }],
    },
    // --- classes / enums / namespaces with runtime emit ---
    {
      code: "export class OrderService { create() { return null; } }",
      errors: [{ messageId: "classBody", data: { name: "OrderService" } }],
    },
    {
      code: "export abstract class Base {}",
      errors: [{ messageId: "classBody", data: { name: "Base" } }],
    },
    {
      code: "export enum Status { Open, Paid }",
      errors: [{ messageId: "enumRuntime", data: { name: "Status" } }],
    },
    {
      // even ambient enums are banned: lint-passing must imply scaffoldable
      code: "export declare enum Level { Low, High }",
      errors: [{ messageId: "enumRuntime", data: { name: "Level" } }],
    },
    {
      code: "export namespace Orders { export const version = 1; }",
      errors: [{ messageId: "namespaceRuntime", data: { name: "Orders" } }],
    },
    // --- concrete imports / exports (TN: no concrete infra imports) ---
    {
      code: "import { Pool } from 'pg';\nexport interface Db { pool: Pool; }",
      errors: [{ messageId: "valueImport", data: { source: "pg" } }],
    },
    {
      code: "import * as fs from 'node:fs';",
      errors: [{ messageId: "valueImport", data: { source: "node:fs" } }],
    },
    {
      code: "import fs = require('node:fs');",
      errors: [{ messageId: "importEquals", data: { source: "node:fs" } }],
    },
    {
      code: "import { type Pool, Client } from 'pg';", // one value specifier poisons it
      errors: [{ messageId: "valueImport", data: { source: "pg" } }],
    },
    {
      code: "export { createOrder } from './orders.js';",
      errors: [{ messageId: "valueExport", data: { source: "./orders.js" } }],
    },
    {
      code: "export * from './orders.js';",
      errors: [{ messageId: "valueExport", data: { source: "./orders.js" } }],
    },
    {
      code: "export = Order;",
      errors: [{ messageId: "exportAssignment" }],
    },
    // --- stray runtime statements ---
    {
      code: "console.log('side effect');",
      errors: [{ messageId: "sideEffect" }],
    },
    {
      code: "export default { port: 3000 };",
      errors: [{ messageId: "defaultValue" }],
    },
    // --- multiple sins, multiple reports ---
    {
      code: "import { Pool } from 'pg';\nexport const pool = new Pool();",
      errors: [
        { messageId: "valueImport", data: { source: "pg" } },
        { messageId: "valueBinding", data: { name: "pool" } },
      ],
    },
  ],
});
