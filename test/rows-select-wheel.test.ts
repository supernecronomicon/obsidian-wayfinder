import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { DEFAULT_SETTINGS, parseTicketsPerRow, sanitizeSettings } from "../src/config";
import { selectDependency } from "../src/interaction";
import { wrapTicketRows } from "../src/tree-layout";
import { wheelTransform } from "../src/viewport";
import { viewportWheel } from "../src/viewport-wheel";

test("row limit defaults to 15, accepts positive integers, and treats empty/zero as unlimited", () => {
  assert.equal(DEFAULT_SETTINGS.ticketsPerRow, 15);
  assert.equal(sanitizeSettings({}).ticketsPerRow, 15);
  for (const value of ["", "  ", 0, "0"]) {
    assert.equal(parseTicketsPerRow(value), 0);
    assert.equal(sanitizeSettings({ ticketsPerRow: value }).ticketsPerRow, 0);
  }
  for (const value of [1, "15", " 200 "]) {
    assert.equal(parseTicketsPerRow(value), Number(value));
  }
  for (const value of [-1, 1.5, "1.5", "junk", NaN, Infinity, null, true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseTicketsPerRow(value), null);
    assert.equal(sanitizeSettings({ ticketsPerRow: value }).ticketsPerRow, 15);
  }
});

test("wrapped ticket positions preserve dependency layers and ordered row/column slots", () => {
  const layers = [["a", "b", "c", "d", "e"], ["f"], ["g", "h", "i"]];
  const rows = wrapTicketRows(layers, 2);
  const positions = new Map(rows.flatMap((row, y) => row.map((key, x) => [key, { row: y, column: x }] as const)));
  assert.deepEqual(rows, [["a", "b"], ["c", "d"], ["e"], ["f"], ["g", "h"], ["i"]]);
  assert.deepEqual(positions.get("c"), { row: 1, column: 0 });
  assert.deepEqual(positions.get("e"), { row: 2, column: 0 });
  assert.deepEqual(positions.get("f"), { row: 3, column: 0 });
  // Edge endpoints retain their issue identities and every dependant layer is below its blockers.
  for (const [from, to] of [["a", "f"], ["e", "f"], ["f", "i"]]) {
    assert.ok(positions.get(from)!.row < positions.get(to)!.row);
  }
  assert.deepEqual(layers, [["a", "b", "c", "d", "e"], ["f"], ["g", "h", "i"]]);
});

test("row boundary, disabled limit, empty maps, and setting changes have deterministic positions", () => {
  const tickets = Array.from({ length: 31 }, (_, i) => i);
  assert.deepEqual(wrapTicketRows([tickets], 15).map((row) => row.length), [15, 15, 1]);
  assert.deepEqual(wrapTicketRows([tickets.slice(0, 15)], 15).map((row) => row.length), [15]);
  assert.deepEqual(wrapTicketRows([tickets], 1), tickets.map((ticket) => [ticket]));
  assert.deepEqual(wrapTicketRows([tickets], 0), [tickets]);
  assert.deepEqual(wrapTicketRows([tickets], 50), [tickets]);
  assert.deepEqual(wrapTicketRows([[], []], 15), []);
  const before = wrapTicketRows([tickets], 15);
  const after = wrapTicketRows([tickets], 10);
  assert.deepEqual(after.map((row) => row[0]), [0, 10, 20, 30]);
  assert.deepEqual(before.map((row) => row[0]), [0, 15, 30]);
});

test("search selection replaces a previously selected ticket and stale hover, including other repos", () => {
  const before = { selected: "owner/one#7", hovered: "owner/one#9" };
  const after = selectDependency(before, "owner/two#7");
  assert.deepEqual(after, { selected: "owner/two#7", hovered: null });
  assert.deepEqual(before, { selected: "owner/one#7", hovered: "owner/one#9" });
  assert.deepEqual(selectDependency(after, "owner/two#7"), after);
  assert.deepEqual(selectDependency(after, null), { selected: null, hovered: null });
});

const size = { width: 960, height: 640 };
const anchor = { x: 250, y: 180 };
const wheel = { deltaX: 3.5, deltaY: -7.25, deltaMode: 0, ctrlKey: false, metaKey: false };

test("2-D wheel transform applies fractional, unequal axes together at every zoom", () => {
  for (const zoom of [0.5, 1, 2]) {
    const before = { x: 12, y: -30, zoom };
    assert.deepEqual(wheelTransform(before, wheel, size, anchor), { x: 8.5, y: -22.75, zoom });
    assert.deepEqual(wheelTransform(before, { ...wheel, deltaMode: 1 }, size, anchor), { x: -44, y: 86, zoom });
    assert.deepEqual(wheelTransform(before, { ...wheel, deltaMode: 2 }, size, anchor), { x: -3348, y: 4610, zoom });
    assert.deepEqual(before, { x: 12, y: -30, zoom });
  }
});

test("a changing trackpad direction and momentum never latch to the first or dominant axis", () => {
  let view = { x: 0, y: 0, zoom: 1 };
  for (const [x, y] of [[0, 8], [0.25, 7], [2, 6], [5, 4], [7, 1], [3, 0.5]]) {
    view = wheelTransform(view, { ...wheel, deltaX: x, deltaY: y }, size, anchor);
  }
  assert.deepEqual(view, { x: -17.25, y: -26.5, zoom: 1 });
});

test("Ctrl/Cmd wheel still zooms around the pointer instead of diagonal panning", () => {
  const before = { x: -100, y: -200, zoom: 1 };
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    const after = wheelTransform(before, { ...wheel, ...modifier }, size, anchor);
    assert.ok(after.zoom > before.zoom);
    assert.ok(Math.abs((anchor.x - after.x) / after.zoom - (anchor.x - before.x)) < 1e-9);
    assert.ok(Math.abs((anchor.y - after.y) / after.zoom - (anchor.y - before.y)) < 1e-9);
  }
});

function eventFixture(path: EventTarget[], target: EventTarget) {
  let prevented = false;
  let stopped = false;
  const event = {
    ...wheel, target, clientX: 300, clientY: 200,
    composedPath: () => path,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  } as unknown as WheelEvent;
  return { event, prevented: () => prevented, stopped: () => stopped };
}

test("wheel event routing accepts a pop-out realm target rejected by the old instanceof guard", () => {
  // Separate windows have separate Node constructors, just as separate JS realms do here.
  const MainNode = runInNewContext("class Node {}; Node") as new () => EventTarget;
  const foreignTarget = runInNewContext("new (class Node {})()") as EventTarget;
  assert.equal(foreignTarget instanceof MainNode, false);
  const viewport = {
    clientWidth: size.width, clientHeight: size.height,
    getBoundingClientRect: () => ({ left: 50, top: 20 }),
  } as unknown as HTMLElement;
  const fixture = eventFixture([foreignTarget, viewport], foreignTarget);
  assert.deepEqual(viewportWheel(fixture.event, viewport, { x: 0, y: 0, zoom: 1 }),
    { x: -3.5, y: 7.25, zoom: 1 });
  assert.equal(fixture.prevented(), true);
  assert.equal(fixture.stopped(), true);
});

test("toolbar and other-window wheel events remain outside this viewport owner", () => {
  const viewport = {} as HTMLElement;
  const target = {} as EventTarget;
  const fixture = eventFixture([target], target);
  const view = { x: 0, y: 0, zoom: 1 };
  assert.equal(viewportWheel(fixture.event, viewport, view), null);
  assert.equal(viewportWheel(fixture.event, null, view), null);
  assert.equal(fixture.prevented(), false);
  assert.equal(fixture.stopped(), false);
});
