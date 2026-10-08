import type { DecisionIds } from "bounded/application";

/** Random UUIDs from the platform's cryptographic generator. */
export class RandomDecisionIds implements DecisionIds {
  next(): string {
    return crypto.randomUUID();
  }
}
