import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient, type Http, type HttpResponse } from "../src/github";
import { priorityLevelOf, priorityOf } from "../src/model";

test("priority labels: both schemes map onto one P0-P3 scale", () => {
  assert.equal(priorityLevelOf("priority:p0"), 0);
  assert.equal(priorityLevelOf("priority:urgent"), 0);
  assert.equal(priorityLevelOf("priority:P1"), 1);
  assert.equal(priorityLevelOf("Priority:High"), 1);
  assert.equal(priorityLevelOf("priority:medium"), 2);
  assert.equal(priorityLevelOf("priority:p3"), 3);
  assert.equal(priorityLevelOf("priority:low"), 3);
  assert.equal(priorityLevelOf("priority:p4"), null);
  assert.equal(priorityLevelOf("wayfinder:task"), null);
  assert.equal(priorityLevelOf("high"), null);
});

test("priority: none, single, and conflicting labels", () => {
  assert.equal(priorityOf(["wayfinder:task"]), null);
  assert.deepEqual(priorityOf(["priority:high"]), { level: 1, conflicting: [] });
  assert.deepEqual(priorityOf(["priority:low", "priority:p1", "x"]), {
    level: 1,
    conflicting: ["priority:low", "priority:p1"],
  });
});

function res(status: number, json: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, json };
}

function issue(labels: string[]): Record<string, unknown> {
  return {
    number: 7, title: "T", state: "open", body: null, assignees: [],
    labels: labels.map((name) => ({ name })),
    html_url: "https://github.test/issues/7", updated_at: "2026-01-01T00:00:00Z",
  };
}

test("setPriority replaces every priority label and keeps the others", async () => {
  let written: unknown = null;
  const http: Http = async (url, _headers, write) => {
    if (write) {
      written = JSON.parse(write.body);
      return res(200, (written as { labels: string[] }).labels.map((name) => ({ name })));
    }
    return res(200, issue(["wayfinder:task", "priority:low", "priority:p2"]));
  };
  const gh = new GitHubClient(() => ({ token: "t", repo: "o/r" }), http);
  const result = await gh.setPriority(7, 0);
  assert.deepEqual(written, { labels: ["wayfinder:task", "priority:p0"] });
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.deepEqual(result.issue.labels, ["wayfinder:task", "priority:p0"]);

  await gh.setPriority(7, null);
  assert.deepEqual(written, { labels: ["wayfinder:task"] });
});

test("setPriority reports a read-only token as denied, not an error", async () => {
  const http: Http = async (_url, _h, write) =>
    write ? res(403, { message: "Resource not accessible by personal access token" }) : res(200, issue([]));
  const gh = new GitHubClient(() => ({ token: "t", repo: "o/r" }), http);
  assert.deepEqual(await gh.setPriority(7, 1), { status: "denied" });
});

test("setPriority treats a rate limit as an error, not as read-only", async () => {
  const http: Http = async (_url, _h, write) =>
    write ? res(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" }) : res(200, issue([]));
  const gh = new GitHubClient(() => ({ token: "t", repo: "o/r" }), http);
  await assert.rejects(gh.setPriority(7, 1), /rate limit/);
});
