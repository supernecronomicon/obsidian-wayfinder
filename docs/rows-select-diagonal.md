# Rows, search selection, and diagonal pan — 26 October 2026

## Layout and search

`tree.ts` remains the tree layout owner. It now splits each dependency layer
(and each external ghost layer) into ordered rows with `wrapTicketRows` before
rendering. Existing CSS determines card sizes and spacing. `drawEdges` still
resolves endpoints by repository-qualified issue keys and reads the final DOM
rectangles, so wrapping does not require a second coordinate/layout model.
Saving settings already emits `wayfinder:settings`, which re-renders open views
and schedules edge drawing after layout.

Search previously changed only focus, animation, and a four-second flash. It
never replaced `dependencySelection`, so the previously clicked ticket kept
owning the graph highlight. Search now uses the same persistent selection
transition as a click and the exact activation callback registered by the card.
This also preserves the tree/list/delegation differences in activation and keeps
the animated move.

## Diagonal pan investigation

Reading the baseline at `cb43092` rules out an axis-selection branch in the
plugin math: `wheelPixels` returns both axes, and `pan` applies both in the same
transform. The wheel listener was already non-passive and called
`preventDefault`. The viewport uses `overflow: clip` and `touch-action: none`;
the tree wrapper is not a native overflow scroller.

There is a concrete event-routing defect: the old `inViewport` guard uses
`target instanceof Node` from the main JavaScript window. A DOM target from an
Obsidian pop-out window has a different `Node` constructor, so the handler
returns before cancelling native scrolling or applying either axis. The new
`viewportWheel` uses the event's composed path to establish ownership across
windows. A non-passive capture listener consumes owned wheel events before
descendant/ancestor bubble handlers; one `wheelTransform` applies both deltas.

The regression test demonstrates the foreign-realm constructor mismatch and
asserts that the new routing cancels the event and returns a simultaneous X/Y
translation. Pure tests cover fractional/unequal deltas, changing direction
within one gesture, momentum-sized updates, all delta modes and zoom levels,
and pointer-anchored Ctrl/Cmd zoom. These are synthetic events, not macOS device
input.

Chromium's native rails are also relevant when wheel events go unconsumed:
[`MouseWheelEventQueue::ProcessMouseWheelAck`](https://github.com/chromium/chromium/blob/main/components/input/mouse_wheel_event_queue.cc)
zeros one axis when generating native gesture scroll updates in a rails mode.
It does so after wheel acknowledgement; this is not evidence that raw DOM wheel
deltas themselves lose an axis.

**Operator symptom remains unconfirmed.** There is no macOS Obsidian/trackpad
session in this environment, and the report does not establish that a pop-out
window was involved. The cross-window routing defect is fixed, but it would be
incorrect to claim it proves the cause or resolution of the operator's exact
report. If that report reproduces in the main window, the remaining cause is
unknown; actual event paths, deltaX/deltaY and cancellation state in that
session are needed to distinguish native input filtering from host/plugin
interception. Report this as `DIAGONAL-NOT-FIXED` rather than repeating PR #7's
unverified device-level claim.

## Adversarial self-review

- Checked defaults/migration, zero/empty, invalid and fractional input, exact
  row boundaries, a partial final row, empty layers, and repeated re-layout.
- Checked stable issue identities and that wrapping finishes each dependency
  layer before placing the next; final DOM geometry still owns edge endpoints.
- Checked replacement of an old selection and stale hover, repository number
  collisions, repeated selection, and equal click/keyboard/search activation
  effects (including details callbacks).
- Checked unequal wheel axes, small secondary-axis values, changing gesture
  direction, pop-out realm routing, wheel events outside the viewport, zoom
  anchoring, and native cancellation. Did not equate these synthetic checks
  with a real macOS trackpad reproduction.
