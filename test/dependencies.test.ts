import assert from "node:assert/strict";
import test from "node:test";
import { buildModel, dependencyClosure, dependencyGraph, loadedDependencyGraph, type DependencyGraph, type RawIssue, type Snapshot } from "../src/model";

function graph(edges: [string, string][]): DependencyGraph {
  return { nodes: [], edges: edges.map(([from, to]) => ({ from, to, ghost: false })) };
}

test("regression: #1171 traces #1170 back to #1153; #1153 traces both downstream levels", () => {
  const chain = graph([["owner/repo#1153", "owner/repo#1170"], ["owner/repo#1170", "owner/repo#1171"]]);
  const expected = ["owner/repo#1153", "owner/repo#1170", "owner/repo#1171"];
  for (const key of expected) assert.deepEqual([...dependencyClosure(chain, key)].sort(), expected);
});

test("tracing follows both directions without taking sibling or co-blocker detours", () => {
  const branches = graph([["a", "b"], ["b", "c"], ["a", "sibling"], ["co-blocker", "c"], ["unrelated", "other"]]);
  assert.deepEqual([...dependencyClosure(branches, "b")].sort(), ["a", "b", "c"]);
});

test("cycles and duplicate edges terminate, and isolated selection remains highlighted", () => {
  const cycle = graph([["a", "b"], ["b", "c"], ["c", "a"], ["a", "b"], ["c", "d"], ["e", "a"]]);
  assert.deepEqual([...dependencyClosure(cycle, "b")].sort(), ["a", "b", "c", "d", "e"]);
  assert.deepEqual([...dependencyClosure(cycle, "isolated")], ["isolated"]);
});

function issue(number: number, parent?: number, state: "open" | "closed" = "open"): RawIssue {
  return { number, title: `Issue ${number}`, state, body: parent ? `Part of #${parent}` : null,
    labels: [parent ? "wayfinder:task" : "wayfinder:map"], assignees: [], updated_at: "",
    html_url: `https://github.com/owner/repo/issues/${number}` };
}

test("loaded graph traces across maps and repositories through a filtered closed intermediate", () => {
  const first: Snapshot = { schemaVersion: 2, repo: "owner/repo", fetchedAt: 1, parents: {},
    issues: [issue(1), issue(2), issue(1153, 1), issue(1171, 2)],
    deps: { 1153: { updatedAt: "", blockedBy: [] }, 1171: { updatedAt: "", blockedBy: [{ number: 1170, repo: "OTHER/REPO" }] } } };
  const other: Snapshot = { schemaVersion: 2, repo: "other/repo", fetchedAt: 1, parents: {},
    issues: [issue(3), issue(1170, 3, "closed")].map((entry) => ({ ...entry, html_url: `https://github.com/other/repo/issues/${entry.number}` })),
    deps: { 1170: { updatedAt: "", blockedBy: [{ number: 1153, repo: "owner/repo" }] } } };
  const snapshots = [first, other];
  const targetMap = buildModel(first).maps.find((map) => map.issue.number === 2)!;
  const rendered = dependencyGraph(targetMap, snapshots);
  assert.ok(!rendered.nodes.some((node) => node.number === 1153), "the upstream node need not be drawn in this map");
  const loaded = loadedDependencyGraph(snapshots);
  assert.deepEqual([...dependencyClosure(loaded, "owner/repo#1171")].sort(), ["other/repo#1170", "owner/repo#1153", "owner/repo#1171"]);
  assert.deepEqual([...dependencyClosure(loaded, "owner/repo#1153")].sort(), ["other/repo#1170", "owner/repo#1153", "owner/repo#1171"]);
  assert.equal(loaded.nodes.find((node) => node.key === "other/repo#1170")?.state, "closed");
  const hiddenMap = buildModel(other).maps[0];
  assert.deepEqual(dependencyGraph({ ...hiddenMap, tickets: [], layers: [] }, snapshots), { nodes: [], edges: [] });
});

test("transitive reverse dependencies respect authoritative loaded blocked-by lists", () => {
  const snapshot: Snapshot = { schemaVersion: 2, repo: "owner/repo", fetchedAt: 1, parents: {},
    issues: [issue(1), issue(1153, 1), issue(1170, 1), issue(1171, 1)],
    deps: { 1170: { updatedAt: "", blockedBy: [{ number: 1153 }] }, 1171: { updatedAt: "", blockedBy: [] } },
    dependants: { 1170: [{ number: 1171 }, { number: 8, repo: "unloaded/repo" }] } };
  assert.deepEqual([...dependencyClosure(loadedDependencyGraph([snapshot]), "owner/repo#1153")].sort(),
    ["owner/repo#1153", "owner/repo#1170", "unloaded/repo#8"]);
});
