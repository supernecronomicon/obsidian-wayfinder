import assert from "node:assert/strict";
import test from "node:test";
import type { MapTree, Model, RawIssue, Ticket } from "../src/model";
import { mapLabel, searchTickets } from "../src/search";

function issue(number: number, title: string, state: "open" | "closed" = "open"): RawIssue {
  return {
    number,
    title,
    state,
    body: null,
    labels: [],
    assignees: [],
    html_url: `https://github.test/issues/${number}`,
    updated_at: "2026-07-20T00:00:00Z",
  };
}

function ticket(number: number, title: string, state: "open" | "closed" = "open"): Ticket {
  return {
    repo: "o/r",
    issue: issue(number, title, state),
    type: "task",
    mode: "AFK",
    priority: null,
    parent: null,
    blockers: [],
    blockedBy: [],
    openBlockers: [],
    unverified: false,
    frontier: false,
    downstreamImpact: 0,
    layer: 0,
  };
}

function map(number: number, title: string, tickets: Ticket[]): MapTree {
  return { repo: "o/r", issue: issue(number, title), tickets, layers: [tickets], resolved: 0, total: tickets.length };
}

const model: Model = {
  maps: [
    map(10, "Search map", [ticket(12, "Add ticket search"), ticket(120, "Fix sync", "closed")]),
    map(20, "Other map", [ticket(21, "Ticket search follow-up")]),
  ],
  orphans: [ticket(30, "Stray search note")],
  tallies: [],
  totalIssues: 0,
  totalOpen: 0,
  fetchedAt: 0,
};

const numbers = (query: string): number[] =>
  searchTickets(model, query).map((hit) => hit.ticket.issue.number);

test("a number query puts the exact ticket first and its map alongside", () => {
  const hits = searchTickets(model, "#12");
  assert.deepEqual(hits.map((hit) => hit.ticket.issue.number), [12, 120]);
  assert.equal(hits[0].map?.issue.number, 10);
});

test("every title word must match, case-insensitively, across maps and orphans", () => {
  assert.deepEqual(numbers("SEARCH ticket"), [21, 12]);
  assert.deepEqual(numbers("stray"), [30]);
});

test("open tickets sort before closed ones, even newer closed ones", () => {
  assert.deepEqual(numbers("1"), [12, 120]);
});

test("no match and an empty query both return nothing", () => {
  assert.deepEqual(numbers("nonexistent"), []);
  assert.deepEqual(numbers("   "), []);
});

test("the map label names the map, or says the ticket has none", () => {
  const [inMap] = searchTickets(model, "12");
  assert.equal(mapLabel(inMap, false), "in map #10 Search map");
  const [orphan] = searchTickets(model, "30");
  assert.equal(mapLabel(orphan, true), "o/r · not in any map");
});
