import { type BeforeTool, Verdict } from "bounded/domain";

/** Before every tool call: allow it. */
export const allowEveryCall: BeforeTool = async () => Verdict.allow;
