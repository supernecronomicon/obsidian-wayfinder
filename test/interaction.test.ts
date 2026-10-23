import assert from "node:assert/strict";
import { after, test } from "node:test";
import { makeInteractive } from "../src/interaction";

/** Minimal event surface; full card/modal wiring is exercised in the browser harness. */
class Surface extends EventTarget {
  attributes = new Map<string, string>();
  setAttr(key: string, value: string): void { this.attributes.set(key, value); }
  closest(): null { return null; }
}

const previousElement = Object.getOwnPropertyDescriptor(globalThis, "Element");
Object.defineProperty(globalThis, "Element", { configurable: true, value: Surface });
after(() => {
  if (previousElement) Object.defineProperty(globalThis, "Element", previousElement);
  else Reflect.deleteProperty(globalThis, "Element");
});

function setup(openable = true) {
  const surface = new Surface();
  const calls: string[] = [];
  makeInteractive(
    surface as unknown as HTMLElement,
    () => calls.push("select"),
    openable ? () => calls.push("select", "open") : undefined,
  );
  const fire = (type: string, properties = {}): Event => {
    const event = Object.assign(new Event(type, { cancelable: true }), properties);
    surface.dispatchEvent(event);
    return event;
  };
  return { surface, calls, fire };
}

test("single click selects without opening, including programmatic activation", () => {
  const { surface, calls, fire } = setup();
  assert.equal(surface.attributes.get("tabindex"), "0");
  assert.equal(surface.attributes.get("role"), "button");
  fire("click", { detail: 1 });
  assert.deepEqual(calls, ["select"]);
  fire("click", { detail: 0 });
  assert.deepEqual(calls, ["select", "select"]);
});

test("double-click selects then opens once without a second selection toggle", () => {
  const { calls, fire } = setup();
  fire("click", { detail: 1 });
  fire("click", { detail: 2 });
  assert.deepEqual(calls, ["select"]);
  const event = fire("dblclick", { detail: 2 });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls, ["select", "select", "open"]);
});

test("Enter and Space select; Shift+Enter selects and opens", () => {
  const { calls, fire } = setup();
  assert.equal(fire("keydown", { key: "Enter" }).defaultPrevented, true);
  assert.equal(fire("keydown", { key: " " }).defaultPrevented, true);
  assert.deepEqual(calls, ["select", "select"]);
  assert.equal(fire("keydown", { key: "Enter", shiftKey: true }).defaultPrevented, true);
  assert.deepEqual(calls, ["select", "select", "select", "open"]);
  fire("keydown", { key: "Escape" });
  assert.equal(calls.length, 4);
});

test("navigation-only cards activate once during a double-click and retain keyboard activation", () => {
  const { calls, fire } = setup(false);
  fire("click", { detail: 1 });
  fire("click", { detail: 2 });
  fire("dblclick", { detail: 2 });
  assert.deepEqual(calls, ["select"]);
  fire("keydown", { key: "Enter", shiftKey: true });
  assert.deepEqual(calls, ["select", "select"]);
});
