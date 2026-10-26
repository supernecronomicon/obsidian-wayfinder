import { wheelTransform, type ViewTransform } from "./viewport";

/** Event paths work across Obsidian windows; main-window `instanceof Node` does not.
 * Consume before native scrolling (and its macOS axis rails) or parent handlers.
 */
export function viewportWheel(
  event: WheelEvent,
  viewport: HTMLElement | null,
  view: ViewTransform,
): ViewTransform | null {
  if (!viewport || !event.composedPath().includes(viewport)) return null;
  event.preventDefault();
  event.stopPropagation();
  const bounds = viewport.getBoundingClientRect();
  return wheelTransform(view, event,
    { width: viewport.clientWidth, height: viewport.clientHeight },
    { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
}
