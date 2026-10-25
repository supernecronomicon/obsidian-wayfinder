import assert from "node:assert/strict";
import { test } from "node:test";
import {
  animationFrame, clampZoom, easeInOut, navigationTarget, panBy,
  wheelPixels, wheelZoom, zoomAt, ZOOM_MAX, ZOOM_MIN,
  type Point, type ViewTransform,
} from "../src/viewport";

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

function mapPoint(view: ViewTransform, screen: Point): Point {
  return { x: (screen.x - view.x) / view.zoom, y: (screen.y - view.y) / view.zoom };
}

test("stored zoom uses the existing limits and recovers from malformed device state", () => {
  assert.equal(clampZoom(NaN), 1);
  assert.equal(clampZoom(Infinity), 1);
  assert.equal(clampZoom(-10), ZOOM_MIN);
  assert.equal(clampZoom(10), ZOOM_MAX);
  assert.equal(clampZoom(1.234567), 1.234567);
});

test("zoom keeps the map point under any pointer fixed after diagonal panning", () => {
  for (const zoom of [ZOOM_MIN, 0.73, 1, 1.63, ZOOM_MAX]) {
    const before = { x: -813.4, y: 317.6, zoom };
    for (const anchor of [{ x: 0, y: 0 }, { x: 417.25, y: 268.75 }, { x: 1200, y: 900 }]) {
      for (const requested of [0.1, 0.51, 1.07, 1.89, 8]) {
        const after = zoomAt(before, requested, anchor);
        const oldPoint = mapPoint(before, anchor);
        const newPoint = mapPoint(after, anchor);
        near(newPoint.x, oldPoint.x);
        near(newPoint.y, oldPoint.y);
        assert.equal(after.zoom, clampZoom(requested));
      }
    }
  }
});

test("anchored zoom reverses without drift and cannot pan at a zoom limit", () => {
  const before = { x: -230, y: -712, zoom: 1 };
  const anchor = { x: 351, y: 229 };
  const restored = zoomAt(zoomAt(before, 1.78, anchor), 1, anchor);
  near(restored.x, before.x);
  near(restored.y, before.y);
  const atMax = { ...before, zoom: ZOOM_MAX };
  assert.deepEqual(zoomAt(atMax, 4, anchor), atMax);
  const atMin = { ...before, zoom: ZOOM_MIN };
  assert.deepEqual(zoomAt(atMin, 0.1, anchor), atMin);
});

test("diagonal drag applies both axes in screen space at every zoom", () => {
  for (const zoom of [ZOOM_MIN, 1, ZOOM_MAX]) {
    const before = { x: 42, y: -81, zoom };
    const delta = { x: -18.25, y: 31.75 };
    assert.deepEqual(panBy(before, delta), { x: 23.75, y: -49.25, zoom });
    assert.deepEqual(before, { x: 42, y: -81, zoom });
    assert.deepEqual(panBy(panBy(before, delta), { x: -delta.x, y: -delta.y }), before);
  }
});

test("wheel normalisation preserves simultaneous X/Y in pixel, line and page modes", () => {
  const viewport = { width: 960, height: 640 };
  const delta = { x: 1.5, y: -2 };
  assert.deepEqual(wheelPixels(delta, 0, viewport), delta);
  assert.deepEqual(wheelPixels(delta, 1, viewport), { x: 24, y: -32 });
  assert.deepEqual(wheelPixels(delta, 2, viewport), { x: 1440, y: -1280 });
  const pixels = wheelPixels(delta, 0, viewport);
  assert.deepEqual(panBy({ x: 0, y: 0, zoom: 1 }, { x: -pixels.x, y: -pixels.y }),
    { x: -1.5, y: 2, zoom: 1 });
});

test("wheel zoom is proportional to magnitude and invariant to event subdivision", () => {
  const one = wheelZoom(1, -60);
  const many = Array.from({ length: 12 }).reduce<number>((z) => wheelZoom(z, -5), 1);
  near(many, one);
  near(wheelZoom(wheelZoom(1, -60), 60), 1);
  near(wheelZoom(0.7, -10) / 0.7, wheelZoom(1.4, -10) / 1.4);
  assert.ok(wheelZoom(1, -1) > 1 && wheelZoom(1, -1) < 1.01);
  assert.ok(wheelZoom(1, -60) > wheelZoom(1, -1));
  assert.equal(wheelZoom(1, 0), 1);
  assert.equal(wheelZoom(1, -100000), ZOOM_MAX);
  assert.equal(wheelZoom(1, 100000), ZOOM_MIN);
});

test("moving pinch midpoint pans while its original map point remains anchored", () => {
  const before = { x: -100, y: -200, zoom: 0.8 };
  const oldMidpoint = { x: 250, y: 320 };
  const newMidpoint = { x: 270, y: 350 };
  const afterPan = panBy(before, { x: 20, y: 30 });
  const afterPinch = zoomAt(afterPan, before.zoom * 1.2, newMidpoint);
  const original = mapPoint(before, oldMidpoint);
  const current = mapPoint(afterPinch, newMidpoint);
  near(current.x, original.x);
  near(current.y, original.y);
});

test("navigation centres a distant ticket at readable scale, independent of current transform", () => {
  const ticket = { x: 3400, y: 7200, width: 185, height: 140 };
  const viewport = { width: 1000, height: 700 };
  const target = navigationTarget(ticket, viewport);
  assert.equal(target.zoom, 1);
  near((ticket.x + ticket.width / 2) * target.zoom + target.x, viewport.width / 2);
  near((ticket.y + ticket.height / 2) * target.zoom + target.y, viewport.height / 2);
});

test("navigation fits a wide list row or tall card with padding and respects zoom bounds", () => {
  const viewport = { width: 480, height: 360 };
  for (const ticket of [
    { x: -100, y: -200, width: 700, height: 100 },
    { x: 0, y: 100, width: 185, height: 500 },
  ]) {
    const target = navigationTarget(ticket, viewport);
    assert.ok(target.zoom >= ZOOM_MIN && target.zoom < 1);
    assert.ok(ticket.width * target.zoom <= viewport.width - 64);
    assert.ok(ticket.height * target.zoom <= viewport.height - 64);
    near((ticket.x + ticket.width / 2) * target.zoom + target.x, viewport.width / 2);
    near((ticket.y + ticket.height / 2) * target.zoom + target.y, viewport.height / 2);
  }
  assert.equal(navigationTarget({ x: 0, y: 0, width: 10000, height: 10000 }, viewport).zoom, ZOOM_MIN);
  const tiny = navigationTarget({ x: 0, y: 0, width: 0, height: 0 }, { width: 0, height: 0 });
  assert.ok(Object.values(tiny).every(Number.isFinite));
});

test("animation eases both pan axes and scale, with exact end state even after late frames", () => {
  const from = { x: 0, y: 55, zoom: 2 };
  const to = { x: -4000, y: -3000, zoom: 0.73 };
  assert.equal(easeInOut(-1), 0);
  assert.equal(easeInOut(2), 1);
  assert.equal(easeInOut(0.5), 0.5);
  assert.ok(easeInOut(0.1) < 0.1);
  assert.ok(easeInOut(0.9) > 0.9);
  assert.deepEqual(animationFrame(from, to, -0.1), from);
  assert.deepEqual(animationFrame(from, to, 0), from);
  assert.deepEqual(animationFrame(from, to, 0.5), { x: -2000, y: -1472.5, zoom: 1.365 });
  assert.deepEqual(animationFrame(from, to, 1), to);
  assert.deepEqual(animationFrame(from, to, 5), to);
  let previous = from;
  for (let frame = 1; frame <= 100; frame++) {
    const current = animationFrame(from, to, frame / 100);
    assert.ok(current.x <= previous.x && current.y <= previous.y && current.zoom <= previous.zoom);
    previous = current;
  }
  assert.deepEqual(previous, to);
});

test("interrupted navigation can resume from the currently displayed state without a jump", () => {
  const from = { x: 13, y: 24, zoom: 1.7 };
  const first = { x: -2000, y: -600, zoom: 1 };
  const interrupted = animationFrame(from, first, 0.4);
  const panned = panBy(interrupted, { x: 50, y: -75 });
  const second = navigationTarget({ x: 30, y: 40, width: 185, height: 140 }, { width: 900, height: 600 });
  assert.deepEqual(animationFrame(panned, second, 0), panned);
  assert.deepEqual(animationFrame(panned, second, 1), second);
});
