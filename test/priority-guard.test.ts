import assert from "node:assert/strict";
import test from "node:test";
import type { PriorityWrite } from "../src/github";
import type { PriorityLevel, RawIssue } from "../src/model";
import { PriorityWriteGuard } from "../src/priority-guard";

function issue(number: number): RawIssue {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    body: null,
    labels: [],
    assignees: [],
    html_url: `https://github.test/issues/${number}`,
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function fakeClient() {
  const writes: { issueNumber: number; level: PriorityLevel | null }[] = [];
  let gate: Promise<void> = Promise.resolve();
  let open: (() => void) | null = null;
  let fail: Error | null = null;
  let denied = false;
  return {
    writes,
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      open?.();
      open = null;
      gate = Promise.resolve();
    },
    failNext(error: Error) {
      fail = error;
    },
    deny() {
      denied = true;
    },
    async setPriority(issueNumber: number, level: PriorityLevel | null): Promise<PriorityWrite> {
      writes.push({ issueNumber, level });
      await gate;
      const error = fail;
      fail = null;
      if (error) throw error;
      if (denied) return { status: "denied" };
      return { status: "ok", issue: issue(issueNumber) };
    },
  };
}

test("concurrent priority sets on one node: the second is refused, one write runs, and the key is released", async () => {
  const client = fakeClient();
  client.hold();
  const guard = new PriorityWriteGuard();
  const first = guard.set("owner/repo", 7, () => client.setPriority(7, 0));
  const second = await guard.set("owner/repo", 7, () => client.setPriority(7, 1));

  assert.deepEqual(second, { status: "refused" });
  assert.deepEqual(client.writes, [{ issueNumber: 7, level: 0 }]);
  assert.equal(guard.isInFlight("owner/repo", 7), true);

  client.release();
  const done = await first;
  assert.equal(done.status, "ok");
  if (done.status === "ok") assert.equal(done.result.status, "ok");
  assert.equal(guard.isInFlight("owner/repo", 7), false);
  assert.deepEqual(client.writes, [{ issueNumber: 7, level: 0 }]);
});

test("a failed priority set on one node refuses a concurrent set, writes once, and releases the key", async () => {
  const client = fakeClient();
  client.hold();
  client.failNext(new Error("github down"));
  const guard = new PriorityWriteGuard();
  const first = guard.set("owner/repo", 7, () => client.setPriority(7, 0));
  const second = await guard.set("owner/repo", 7, () => client.setPriority(7, 2));

  assert.deepEqual(second, { status: "refused" });
  assert.deepEqual(client.writes, [{ issueNumber: 7, level: 0 }]);
  assert.equal(guard.isInFlight("owner/repo", 7), true);

  client.release();
  await assert.rejects(first, /github down/);
  assert.equal(guard.isInFlight("owner/repo", 7), false);

  const retry = await guard.set("owner/repo", 7, () => client.setPriority(7, 2));
  assert.equal(retry.status, "ok");
  assert.deepEqual(client.writes, [
    { issueNumber: 7, level: 0 },
    { issueNumber: 7, level: 2 },
  ]);
  assert.equal(guard.isInFlight("owner/repo", 7), false);
});

test("a denied priority set releases the key", async () => {
  const client = fakeClient();
  client.deny();
  const guard = new PriorityWriteGuard();
  const outcome = await guard.set("owner/repo", 7, () => client.setPriority(7, 1));

  assert.deepEqual(outcome, { status: "ok", result: { status: "denied" } });
  assert.deepEqual(client.writes, [{ issueNumber: 7, level: 1 }]);
  assert.equal(guard.isInFlight("owner/repo", 7), false);

  const again = await guard.set("owner/repo", 7, () => client.setPriority(7, null));
  assert.equal(again.status, "ok");
  assert.equal(guard.isInFlight("owner/repo", 7), false);
});

test("concurrent priority sets on different nodes both proceed", async () => {
  const client = fakeClient();
  client.hold();
  const guard = new PriorityWriteGuard();
  const sameRepoOtherIssue = guard.set("owner/one", 2, () => client.setPriority(2, 3));
  const otherRepoSameIssue = guard.set("owner/two", 1, () => client.setPriority(1, 1));
  const first = guard.set("owner/one", 1, () => client.setPriority(1, 0));

  assert.equal(guard.isInFlight("owner/one", 1), true);
  assert.equal(guard.isInFlight("owner/one", 2), true);
  assert.equal(guard.isInFlight("owner/two", 1), true);
  assert.deepEqual(client.writes, [
    { issueNumber: 2, level: 3 },
    { issueNumber: 1, level: 1 },
    { issueNumber: 1, level: 0 },
  ]);

  client.release();
  const results = await Promise.all([sameRepoOtherIssue, otherRepoSameIssue, first]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["ok", "ok", "ok"],
  );
  assert.equal(guard.isInFlight("owner/one", 1), false);
  assert.equal(guard.isInFlight("owner/one", 2), false);
  assert.equal(guard.isInFlight("owner/two", 1), false);
});
