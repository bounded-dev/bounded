import type { DecisionIds } from "bounded/application";
import { DecisionId } from "bounded/domain";

/** A DecisionId of a random UUID, from the platform's cryptographic generator, for each decision. */
export class RandomDecisionIds implements DecisionIds {
  next(): DecisionId {
    // A UUID is always a DecisionId; a failure would throw inside the handlers' recording, a failure to record (fail closed).
    const id = DecisionId.parse(crypto.randomUUID());
    if (!id.ok) throw new Error(id.error);
    return id.value;
  }
}
