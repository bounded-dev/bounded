// An in-memory tracker for unit tests of the lead's commands and the board
// sync (ADR LEG-2026-066). It keeps issues, their board status and labels, records
// every change, and can be switched offline to stand for an unreachable tracker.

import { TrackerError, type BoardStatus, type Tracker, type TrackerIssue } from "../../src/tracker.ts";

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  status?: BoardStatus;
  comments: string[];
}

export class FakeTracker implements Tracker {
  readonly issues = new Map<number, FakeIssue>();
  readonly log: string[] = [];
  offline = false;
  /** Fail every call after this many more succeed (for mid-operation failures). */
  failAfter: number | undefined;
  private next = 1;

  private gate(what: string): void {
    if (this.offline) throw new TrackerError(`${what}: tracker unreachable`);
    if (this.failAfter !== undefined) {
      if (this.failAfter <= 0) throw new TrackerError(`${what}: tracker failed`);
      this.failAfter--;
    }
  }

  private issue(n: number): FakeIssue {
    const issue = this.issues.get(n);
    if (issue === undefined) throw new TrackerError(`issue ${n} not found`);
    return issue;
  }

  seed(issue: Partial<FakeIssue> & { readonly title: string }): number {
    const number = issue.number ?? this.next;
    this.next = Math.max(this.next, number + 1);
    this.issues.set(number, { number, body: "", state: "open", labels: [], comments: [], ...issue });
    return number;
  }

  check(): void { this.gate("check"); }

  createIssue(title: string, body: string): { number: number; url: string } {
    this.gate("create");
    const number = this.seed({ title, body });
    this.log.push(`create #${number}`);
    return { number, url: `https://example.invalid/issues/${number}` };
  }

  viewIssue(n: number): TrackerIssue {
    this.gate("view");
    const i = this.issue(n);
    return { number: i.number, title: i.title, body: i.body, state: i.state, labels: [...i.labels], ...(i.status !== undefined ? { status: i.status } : {}) };
  }

  setStatus(n: number, status: BoardStatus): void {
    this.gate("status");
    this.issue(n).status = status;
    this.log.push(`#${n} → ${status}`);
  }

  addLabel(n: number, label: string): void {
    this.gate("add-label");
    const i = this.issue(n);
    if (!i.labels.includes(label)) i.labels.push(label);
    this.log.push(`#${n} +${label}`);
  }

  removeLabel(n: number, label: string): void {
    this.gate("remove-label");
    const i = this.issue(n);
    i.labels = i.labels.filter((l) => l !== label);
    this.log.push(`#${n} -${label}`);
  }

  issuesWithLabel(label: string): readonly number[] {
    this.gate("list");
    return [...this.issues.values()].filter((i) => i.state === "open" && i.labels.includes(label)).map((i) => i.number);
  }

  comment(n: number, body: string): void {
    this.gate("comment");
    this.issue(n).comments.push(body);
  }

  close(n: number): void {
    this.gate("close");
    this.issue(n).state = "closed";
    this.log.push(`#${n} closed`);
  }
}
