/** Tabbable card: click/Enter/Space selects; optional double-click/Shift+Enter opens. */
export function makeInteractive(
  el: HTMLElement,
  activate: () => void,
  open?: () => void,
): void {
  el.setAttr("tabindex", "0");
  el.setAttr("role", "button");
  el.addEventListener("click", (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest(".wf-actions")) return;
    // The first click already selected (or navigated). Never toggle twice.
    if (event.detail > 1) return;
    activate();
  });
  if (open) {
    el.addEventListener("dblclick", (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".wf-actions")) return;
      event.preventDefault();
      open();
    });
  }
  el.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.target !== el) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (event.key === "Enter" && event.shiftKey && open) open();
      else activate();
    }
  });
}
