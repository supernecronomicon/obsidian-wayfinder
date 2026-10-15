import { issueKey } from "./model";

export type PrioritySetResult<T> = { status: "refused" } | { status: "ok"; result: T };

export class PriorityWriteGuard {
  private inFlight = new Set<string>();

  isInFlight(repo: string, issueNumber: number): boolean {
    return this.inFlight.has(issueKey(repo, issueNumber));
  }

  async set<T>(
    repo: string,
    issueNumber: number,
    write: () => Promise<T>,
  ): Promise<PrioritySetResult<T>> {
    const key = issueKey(repo, issueNumber);
    if (this.inFlight.has(key)) return { status: "refused" };
    this.inFlight.add(key);
    try {
      return { status: "ok", result: await write() };
    } finally {
      this.inFlight.delete(key);
    }
  }
}
