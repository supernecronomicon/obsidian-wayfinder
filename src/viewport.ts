/** Screen-space translation and a uniform map-to-screen scale. Owned by WayfinderView. */
export interface ViewTransform { x: number; y: number; zoom: number }
export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface MapRect extends Point, Size {}

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;

export function clampZoom(zoom: number): number {
  return Number.isFinite(zoom) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) : 1;
}

/** Both axes are applied in screen pixels, independent of zoom. */
export function panBy(view: ViewTransform, delta: Point): ViewTransform {
  return { ...view, x: view.x + delta.x, y: view.y + delta.y };
}

/** Keep the map point beneath anchor fixed, including at the scale limits. */
export function zoomAt(view: ViewTransform, zoom: number, anchor: Point): ViewTransform {
  const next = clampZoom(zoom);
  const ratio = next / view.zoom;
  return {
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
    zoom: next,
  };
}

/** Wheel deltaMode: pixels=0, lines=1, pages=2. Never discard a diagonal axis. */
export function wheelPixels(delta: Point, mode: number, viewport: Size): Point {
  return {
    x: delta.x * (mode === 1 ? 16 : mode === 2 ? viewport.width : 1),
    y: delta.y * (mode === 1 ? 16 : mode === 2 ? viewport.height : 1),
  };
}

/** Exponential scaling makes small pinch deltas fine-grained and steps proportional. */
export function wheelZoom(zoom: number, deltaY: number): number {
  return clampZoom(zoom * Math.exp(-deltaY * 0.002));
}

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** One update per wheel event; never choose a dominant pan axis. */
export function wheelTransform(view: ViewTransform, wheel: WheelInput, viewport: Size, anchor: Point): ViewTransform {
  const delta = wheelPixels({ x: wheel.deltaX, y: wheel.deltaY }, wheel.deltaMode, viewport);
  return wheel.ctrlKey || wheel.metaKey
    ? zoomAt(view, wheelZoom(view.zoom, delta.y), anchor)
    : panBy(view, { x: -delta.x, y: -delta.y });
}

/** Centre a ticket at readable scale, fitting oversized cards into small panes. */
export function navigationTarget(ticket: MapRect, viewport: Size): ViewTransform {
  const zoom = clampZoom(Math.min(
    1,
    Math.max(1, viewport.width - 64) / Math.max(1, ticket.width),
    Math.max(1, viewport.height - 64) / Math.max(1, ticket.height),
  ));
  return {
    x: viewport.width / 2 - (ticket.x + ticket.width / 2) * zoom,
    y: viewport.height / 2 - (ticket.y + ticket.height / 2) * zoom,
    zoom,
  };
}

/** Smooth start/stop with exact, clamped endpoints (including a late RAF). */
export function easeInOut(progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  return t * t * (3 - 2 * t);
}

export function animationFrame(from: ViewTransform, to: ViewTransform, progress: number): ViewTransform {
  if (progress <= 0) return { ...from };
  if (progress >= 1) return { ...to };
  const t = easeInOut(progress);
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    zoom: from.zoom + (to.zoom - from.zoom) * t,
  };
}
