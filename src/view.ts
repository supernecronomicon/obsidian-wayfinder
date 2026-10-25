import { ItemView, Notice, Platform, Scope, WorkspaceLeaf, setIcon } from "obsidian";
import { addIconActions, type TicketCardOptions } from "./cards";
import { HoverCards, relativeTime } from "./hover";
import { makeInteractive } from "./interaction";
import { renderList } from "./list";
import type WayfinderPlugin from "./main";
import type { TakeableVerification } from "./main";
import { TicketModal } from "./modal";
import { mapLabel, type SearchHit } from "./search";
import { TicketSearchModal } from "./search-modal";
import {
  buildModel,
  dependencyGraph,
  issueKey,
  loadedDependencyGraph,
  mergeModels,
  type MapTree,
  type Model,
  type RawIssue,
  type Ticket,
  type DependencyNode,
  type DependencyGraph,
} from "./model";
import { renderToolbar, type MapChoice, type ToolbarControls } from "./toolbar";
import { drawAllEdges, highlightDependencies, renderTree } from "./tree";
import { parseViewMode, projectView, type ViewMode } from "./view-state";
import {
  animationFrame, clampZoom, navigationTarget, panBy, wheelPixels, wheelZoom, zoomAt,
  type Point, type ViewTransform,
} from "./viewport";

export const VIEW_TYPE_WAYFINDER = "wayfinder-maps-view";

const MODE_KEY = "wayfinder-view-mode";
const ZOOM_KEY = "wayfinder-zoom";
const HIDDEN_REPOS_KEY = "wayfinder-hidden-repos";
const SELECTED_MAP_KEY = "wayfinder-selected-map";
const SHOW_COMPLETED_MAPS_KEY = "wayfinder-show-completed-maps";
const INCOMPLETE_TICKETS_ONLY_KEY = "wayfinder-incomplete-tickets-only";

export class WayfinderView extends ItemView {
  /** Per-map collapse override; default is expanded for open maps, collapsed for closed. */
  private collapsedOverride = new Map<string, boolean>();
  /** View-local delegation selection; never persisted. */
  private selectionMode = false;
  private selectedIssues = new Set<string>();
  private dependencySelection: string | null = null;
  private dependencyHover: string | null = null;
  private highlightGraph: DependencyGraph = { nodes: [], edges: [] };

  /** Per-device (localStorage, not synced): phones default to list, desktops to tree. */
  private get mode(): ViewMode {
    return parseViewMode(window.localStorage.getItem(MODE_KEY)) ??
      (Platform.isMobile ? "list" : "tree");
  }

  private set mode(m: ViewMode) {
    window.localStorage.setItem(MODE_KEY, m);
  }

  private get selectedMapKey(): string | null {
    return window.localStorage.getItem(SELECTED_MAP_KEY) || null;
  }

  private get showCompletedMaps(): boolean {
    return storedBoolean(SHOW_COMPLETED_MAPS_KEY, true);
  }

  private get incompleteTicketsOnly(): boolean {
    return storedBoolean(INCOMPLETE_TICKETS_ONLY_KEY, false);
  }

  /** The only map transform; rerenders preserve it, only zoom persists per device. */
  private transform: ViewTransform = {
    x: 0, y: 0,
    zoom: clampZoom(parseFloat(window.localStorage.getItem(ZOOM_KEY) ?? "")),
  };
  private navigationRaf = 0;
  private navigationEnd: ViewTransform | null = null;
  private viewport: HTMLElement | null = null;
  private zoomWrap: HTMLElement | null = null;
  private resetViewportGestures = (): void => {};

  private get zoom(): number {
    return this.transform.zoom;
  }

  private applyTransform(transform: ViewTransform, persistZoom = false): void {
    this.transform = transform;
    this.zoomWrap?.setCssStyles({
      transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})`,
    });
    if (persistZoom) window.localStorage.setItem(ZOOM_KEY, String(transform.zoom));
    const label = this.contentEl.querySelector<HTMLElement>(".wf-zoom-label");
    if (label) label.setText(`${Math.round(transform.zoom * 100)}%`);
  }

  private stopNavigation(): void {
    window.cancelAnimationFrame(this.navigationRaf);
    if (this.navigationEnd) window.localStorage.setItem(ZOOM_KEY, String(this.zoom));
    this.navigationRaf = 0;
    this.navigationEnd = null;
  }

  private setZoom(z: number, anchor?: Point): void {
    this.stopNavigation();
    this.hoverCards.clear();
    this.applyTransform(zoomAt(this.transform, z, anchor ?? {
      x: (this.viewport?.clientWidth ?? 0) / 2, y: (this.viewport?.clientHeight ?? 0) / 2,
    }), true);
  }

  private pan(delta: Point): void {
    this.stopNavigation();
    this.hoverCards.clear();
    this.applyTransform(panBy(this.transform, delta));
  }

  private navigateTo(element: HTMLElement): void {
    const viewport = this.viewport;
    if (!viewport) return;
    this.stopNavigation();
    const rect = element.getBoundingClientRect();
    const bounds = viewport.getBoundingClientRect();
    const from = { ...this.transform };
    const to = navigationTarget({
      x: (rect.left - bounds.left - from.x) / from.zoom,
      y: (rect.top - bounds.top - from.y) / from.zoom,
      width: rect.width / from.zoom, height: rect.height / from.zoom,
    }, { width: viewport.clientWidth, height: viewport.clientHeight });
    this.hoverCards.clear();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.applyTransform(to, true);
      return;
    }
    this.navigationEnd = to;
    const start = window.performance.now();
    const tick = (now: number): void => {
      const progress = (now - start) / 360;
      this.applyTransform(animationFrame(from, to, progress));
      if (progress < 1) this.navigationRaf = window.requestAnimationFrame(tick);
      else {
        this.stopNavigation();
        this.applyTransform(to, true);
      }
    };
    this.navigationRaf = window.requestAnimationFrame(tick);
  }

  private navigateToTicket(ticket: Ticket): void {
    const key = issueKey(ticket.repo, ticket.issue.number);
    const card = Array.from(this.contentEl.querySelectorAll<HTMLElement>("[data-issue-key]:not(.wf-ghost)"))
      .find((el) => el.dataset.issueKey === key);
    if (card) this.navigateTo(card);
  }
  private hoverCards = new HoverCards();
  private resizeObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: WayfinderPlugin) {
    super(leaf);
    // Cmd/Ctrl+F while this view has focus opens ticket search instead of
    // Obsidian's find, which has nothing to search in a custom view.
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "f", (event) => {
      event.preventDefault();
      this.openSearch();
      return false;
    });
    this.scope.register([], "Escape", () => {
      this.clearDependencyHighlight();
      return false;
    });
  }

  /** Search every configured repo, even ones hidden by the repo filter. */
  openSearch(): void {
    const model = mergeModels(
      this.configuredRepos.flatMap((repo) => {
        const snapshot = this.plugin.snapshots[repo];
        return snapshot ? [buildModel(snapshot)] : [];
      }),
    );
    new TicketSearchModal(
      this.app,
      model,
      this.configuredRepos.length > 1,
      (hit) => this.revealTicket(hit),
    ).open();
  }

  /** Loosen only the filters hiding this ticket, then fly to and highlight it. */
  revealTicket(hit: SearchHit): void {
    const { ticket, map } = hit;
    const hidden = this.hiddenRepos;
    if (hidden.delete(ticket.repo)) {
      window.localStorage.setItem(HIDDEN_REPOS_KEY, JSON.stringify([...hidden]));
    }
    if (ticket.issue.state === "closed" && this.incompleteTicketsOnly) {
      window.localStorage.setItem(INCOMPLETE_TICKETS_ONLY_KEY, "false");
    }
    if (map) {
      const mapKey = issueKey(map.repo, map.issue.number);
      if (map.issue.state === "closed" && !this.showCompletedMaps) {
        window.localStorage.setItem(SHOW_COMPLETED_MAPS_KEY, "true");
      }
      if (this.selectedMapKey !== null && this.selectedMapKey !== mapKey) {
        window.localStorage.removeItem(SELECTED_MAP_KEY);
      }
      this.collapsedOverride.set(mapKey, false);
    } else {
      window.localStorage.removeItem(SELECTED_MAP_KEY);
    }
    this.render();

    const key = issueKey(ticket.repo, ticket.issue.number);
    const card = Array.from(
      this.contentEl.querySelectorAll<HTMLElement>("[data-issue-key]:not(.wf-ghost)"),
    ).find((el) => el.dataset.issueKey === key);
    if (!card) {
      new Notice(`Wayfinder: #${ticket.issue.number} is not on the map.`);
      return;
    }
    this.navigateTo(card);
    card.querySelector<HTMLElement>(".wf-card-main")?.focus({ preventScroll: true });
    card.addClass("wf-search-hit");
    window.setTimeout(() => card.removeClass("wf-search-hit"), 4000);
    new Notice(`#${ticket.issue.number} — ${mapLabel(hit, this.configuredRepos.length > 1)}`);
  }

  getViewType(): string {
    return VIEW_TYPE_WAYFINDER;
  }

  getDisplayText(): string {
    return "Wayfinder";
  }

  getIcon(): string {
    return "compass";
  }

  private pollTimer: number | null = null;
  private lastRenderKey: string | null = null;
  private edgeRaf = 0;
  /** updated_at per issue as of the previous render — drives change flashes. */
  private prevUpdated: Map<string, string> | null = null;

  async onOpen(): Promise<void> {
    this.registerEvent(this.plugin.events.on("wayfinder:updated", () => this.onDataUpdated()));
    this.registerEvent(
      this.plugin.events.on("wayfinder:settings", () => {
        this.startPolling();
        this.render();
      }),
    );
    this.startPolling();
    this.registerViewportGestures();
    this.registerDependencyHighlight();
    // Coming back from sleep/background: sync immediately if data is stale.
    this.registerDomEvent(window, "focus", () => {
      const fetchedAt = this.configuredRepos
        .map((repo) => this.plugin.snapshots[repo]?.fetchedAt)
        .filter((value): value is number => value !== undefined);
      const age = Date.now() - (fetchedAt.length > 0 ? Math.min(...fetchedAt) : 0);
      if (age > Math.max(0.5, this.plugin.settings.pollIntervalMinutes) * 60_000) {
        void this.plugin.sync(false);
      }
    });
    this.render();
    void this.plugin.sync(false);
  }

  /** One viewport handles both scroll axes, drag, and pointer-anchored zoom. */
  private registerViewportGestures(): void {
    const inViewport = (target: EventTarget | null): boolean =>
      target instanceof Node && !!this.viewport?.contains(target);
    const localPoint = (x: number, y: number): Point => {
      const bounds = this.viewport!.getBoundingClientRect();
      return { x: x - bounds.left, y: y - bounds.top };
    };
    this.registerDomEvent(
      this.contentEl,
      "wheel",
      (e: WheelEvent) => {
        if (!inViewport(e.target) || !this.viewport) return;
        e.preventDefault();
        const delta = wheelPixels({ x: e.deltaX, y: e.deltaY }, e.deltaMode, {
          width: this.viewport.clientWidth, height: this.viewport.clientHeight,
        });
        if (e.ctrlKey || e.metaKey) {
          this.setZoom(wheelZoom(this.zoom, delta.y), localPoint(e.clientX, e.clientY));
        } else {
          // Plain wheel/two-finger scroll remains pan, including simultaneous X/Y.
          this.pan({ x: -delta.x, y: -delta.y });
        }
      },
      { passive: false },
    );

    const touches = new Map<number, Point>();
    let touchBase: { centre: Point; dist: number } | null = null;
    let drag: { id: number; start: Point; last: Point; viewport: HTMLElement; active: boolean } | null = null;
    let suppressClick = false;
    const touchGeometry = (): { centre: Point; dist: number } | null => {
      const [a, b] = [...touches.values()];
      if (!a) return null;
      return {
        centre: b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a,
        dist: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0,
      };
    };
    this.registerDomEvent(this.contentEl, "pointerdown", (e: PointerEvent) => {
      suppressClick = false;
      if (!inViewport(e.target) || !this.viewport) return;
      this.stopNavigation();
      if (e.target instanceof Element && e.target.closest("button, a, input, select, textarea, .wf-actions")) return;
      const point = { x: e.clientX, y: e.clientY };
      if (e.pointerType === "touch") {
        touches.set(e.pointerId, point);
        touchBase = touchGeometry();
      } else if (e.button === 0 || e.button === 1) {
        drag = { id: e.pointerId, start: point, last: point, viewport: this.viewport, active: false };
        if (e.button === 1) e.preventDefault();
      }
    });
    this.registerDomEvent(
      this.contentEl.ownerDocument,
      "pointermove",
      (e: PointerEvent) => {
        const point = { x: e.clientX, y: e.clientY };
        if (touches.has(e.pointerId) && this.viewport) {
          e.preventDefault();
          const previous = touchBase;
          touches.set(e.pointerId, point);
          touchBase = touchGeometry();
          if (previous && touchBase) {
            const delta = { x: touchBase.centre.x - previous.centre.x, y: touchBase.centre.y - previous.centre.y };
            if (delta.x !== 0 || delta.y !== 0 || previous.dist !== touchBase.dist) {
              suppressClick = true;
              this.viewport.setPointerCapture(e.pointerId);
              this.pan(delta);
              if (previous.dist > 0 && touchBase.dist > 0) {
                this.setZoom(this.zoom * touchBase.dist / previous.dist,
                  localPoint(touchBase.centre.x, touchBase.centre.y));
              }
            }
          }
          return;
        }
        if (!drag || drag.id !== e.pointerId || drag.viewport !== this.viewport) return;
        if (!drag.active && Math.hypot(point.x - drag.start.x, point.y - drag.start.y) < 4) return;
        if (!drag.active) {
          drag.active = true;
          suppressClick = true;
          this.viewport.setPointerCapture(e.pointerId);
          this.viewport.addClass("wf-panning");
          this.hoverCards.clear();
        }
        e.preventDefault();
        this.pan({ x: point.x - drag.last.x, y: point.y - drag.last.y });
        drag.last = point;
      },
      { passive: false },
    );
    const endPointer = (e: PointerEvent): void => {
      touches.delete(e.pointerId);
      touchBase = touchGeometry();
      if (drag?.id === e.pointerId) {
        drag.viewport.removeClass("wf-panning");
        drag = null;
      }
    };
    this.registerDomEvent(this.contentEl.ownerDocument, "pointerup", endPointer);
    this.registerDomEvent(this.contentEl.ownerDocument, "pointercancel", endPointer);
    this.registerDomEvent(this.contentEl, "lostpointercapture", endPointer);
    this.resetViewportGestures = () => {
      const viewport = drag?.viewport ?? this.viewport;
      for (const id of [...touches.keys(), ...(drag ? [drag.id] : [])]) {
        if (viewport?.hasPointerCapture(id)) viewport.releasePointerCapture(id);
      }
      touches.clear();
      touchBase = null;
      drag?.viewport.removeClass("wf-panning");
      drag = null;
    };
    this.registerDomEvent(window, "blur", () => this.resetViewportGestures());
    for (const type of ["click", "dblclick"] as const) {
      this.registerDomEvent(this.contentEl, type, (event: MouseEvent) => {
        if (!suppressClick || event.detail === 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    }
    // Tab navigation can focus cards outside the clipped viewport. Reveal those
    // through the same owner rather than letting the browser scroll hidden boxes.
    this.registerDomEvent(this.contentEl, "focusin", (event: FocusEvent) => {
      if (!(event.target instanceof Element) || !inViewport(event.target) || !this.viewport) return;
      const card = event.target.closest<HTMLElement>("[data-issue-key], .wf-mapcard");
      if (!card) return;
      this.viewport.scrollTop = this.viewport.scrollLeft = 0;
      const rect = card.getBoundingClientRect();
      const bounds = this.viewport.getBoundingClientRect();
      if (rect.left < bounds.left || rect.right > bounds.right || rect.top < bounds.top || rect.bottom > bounds.bottom) {
        this.navigateTo(card);
      }
    });
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motionChanged = (): void => {
      if (!motion.matches || !this.navigationEnd) return;
      const end = this.navigationEnd;
      this.stopNavigation();
      this.applyTransform(end, true);
    };
    motion.addEventListener("change", motionChanged);
    this.register(() => motion.removeEventListener("change", motionChanged));
  }

  async onClose(): Promise<void> {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    window.cancelAnimationFrame(this.edgeRaf);
    this.stopNavigation();
    this.resetViewportGestures();
    this.hoverCards.clear();
    this.resizeObserver?.disconnect();
  }

  private startPolling(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(
      () => void this.plugin.sync(false),
      Math.max(0.5, this.plugin.settings.pollIntervalMinutes) * 60_000,
    );
    this.registerInterval(this.pollTimer);
  }

  /**
   * Re-render only when the data actually changed; otherwise just refresh the
   * sync-status text. A full render every poll would rebuild cards and hover.
   */
  private onDataUpdated(): void {
    const key = this.snapshotKey();
    if (key === this.lastRenderKey) {
      this.updateSyncStatus();
      return;
    }
    this.render();
  }

  private get configuredRepos(): string[] {
    return this.plugin.settings.repos.map((config) => config.repo);
  }

  /**
   * Pure read: names not currently configured are ignored (not erased, so a
   * re-added repo keeps its filter state), and with fewer than two repos the
   * filter is moot — everything shows, since the filter button is hidden too.
   */
  private get hiddenRepos(): Set<string> {
    const configuredRepos = this.configuredRepos;
    if (configuredRepos.length < 2) return new Set();
    const configured = new Set(configuredRepos);
    let stored: unknown = [];
    try {
      stored = JSON.parse(window.localStorage.getItem(HIDDEN_REPOS_KEY) ?? "[]");
    } catch {
      // Invalid local state resets to showing every repository.
    }
    return new Set(
      Array.isArray(stored)
        ? stored.filter((repo): repo is string => typeof repo === "string" && configured.has(repo))
        : [],
    );
  }

  private get shownRepos(): string[] {
    const hidden = this.hiddenRepos;
    return this.configuredRepos.filter((repo) => !hidden.has(repo));
  }

  private shownModel(): Model {
    return mergeModels(
      this.shownRepos.flatMap((repo) => {
        const snapshot = this.plugin.snapshots[repo];
        return snapshot ? [buildModel(snapshot)] : [];
      }),
    );
  }

  private toggleRepo(repo: string): void {
    const hidden = this.hiddenRepos;
    if (hidden.has(repo)) hidden.delete(repo);
    else hidden.add(repo);
    window.localStorage.setItem(HIDDEN_REPOS_KEY, JSON.stringify([...hidden]));
    this.render();
  }

  private showAllRepos(): void {
    window.localStorage.setItem(HIDDEN_REPOS_KEY, "[]");
    this.render();
  }

  private snapshotKey(): string {
    const shownRepos = this.shownRepos;
    const snapshots = this.configuredRepos.map((repo) => {
      const snapshot = this.plugin.snapshots[repo];
      if (!snapshot) return [repo, null];
      return [
        repo,
        {
          fetchedAt: snapshot.fetchedAt,
          issues: snapshot.issues.map(
            (issue) =>
              `${issue.number}:${issue.updated_at}:${issue.state}:${issue.assignees.join(",")}:${issue.labels.join(",")}`,
          ),
          parents: snapshot.parents,
           deps: snapshot.deps,
          dependants: snapshot.dependants,
        },
      ];
    });
    return JSON.stringify({
      shownRepos,
      snapshots,
      errors: this.configuredRepos.map((repo) => [repo, this.plugin.errors[repo] ?? ""]),
      configError: this.plugin.configError,
      syncing: this.configuredRepos.some((repo) => this.plugin.snapshots[repo])
        ? undefined
        : this.plugin.syncing,
    });
  }

  private syncStatusText(
    model = this.shownModel(),
    shownCount = this.shownRepos.length,
  ): string {
    if (model.fetchedAt === 0) return "";
    const age = Date.now() - model.fetchedAt;
    const staleAfter = Math.max(0.5, this.plugin.settings.pollIntervalMinutes) * 3 * 60_000;
    const when = this.plugin.syncing
      ? "syncing…"
      : `synced ${relativeTime(model.fetchedAt)}${age > staleAfter ? " (stale)" : ""}`;
    const repoCount = this.configuredRepos.length;
    const prefix = repoCount > 1 ? `${shownCount}/${repoCount} repos · ` : "";
    return `${prefix}${model.totalIssues} issues · ${model.totalOpen} open · ${when}`;
  }

  private updateSyncStatus(): void {
    const el = this.contentEl.querySelector(".wf-sync-status");
    if (el instanceof HTMLElement) el.setText(this.syncStatusText());
  }

  private scheduleEdges(): void {
    window.cancelAnimationFrame(this.edgeRaf);
    this.edgeRaf = window.requestAnimationFrame(() => {
      drawAllEdges(this.contentEl);
      this.updateDependencyHighlight();
    });
  }

  private updateDependencyHighlight(): void {
    highlightDependencies(this.contentEl, this.dependencySelection ?? this.dependencyHover, this.highlightGraph);
  }

  private clearDependencyHighlight(): void {
    this.dependencySelection = null;
    this.dependencyHover = null;
    this.updateDependencyHighlight();
  }

  private registerDependencyHighlight(): void {
    const cardAt = (target: EventTarget | null): HTMLElement | null =>
      target instanceof Element ? target.closest<HTMLElement>(".wf-ticket[data-issue-key]") : null;
    this.registerDomEvent(this.contentEl, "pointerover", (event) => {
      this.dependencyHover = cardAt(event.target)?.dataset.issueKey ?? null;
      this.updateDependencyHighlight();
    });
    this.registerDomEvent(this.contentEl, "pointerout", (event) => {
      this.dependencyHover = cardAt(event.relatedTarget)?.dataset.issueKey ?? null;
      this.updateDependencyHighlight();
    });
    this.registerDomEvent(this.contentEl, "click", (event) => {
      const card = cardAt(event.target);
      if (card) this.dependencySelection = card.dataset.issueKey ?? null;
      else this.clearDependencyHighlight();
      this.updateDependencyHighlight();
    }, true);
    this.registerDomEvent(this.contentEl, "keydown", (event) => {
      if (event.key === "Escape") this.clearDependencyHighlight();
    });
  }

  private openGhost(node: DependencyNode): void {
    for (const repo of this.configuredRepos) {
      const snapshot = this.plugin.snapshots[repo];
      if (!snapshot) continue;
      const model = buildModel(snapshot);
      const map = model.maps.find((map) => map.tickets.some((ticket) => issueKey(ticket.repo, ticket.issue.number) === node.key));
      const ticket = map?.tickets.find((ticket) => issueKey(ticket.repo, ticket.issue.number) === node.key);
      if (map && ticket) {
        this.revealTicket({ ticket, map });
        return;
      }
    }
    window.open(node.url, "_blank");
  }

  private render(): void {
    const root = this.contentEl;
    this.stopNavigation();
    this.resetViewportGestures();
    this.viewport = null;
    this.zoomWrap = null;
    this.lastRenderKey = this.snapshotKey();
    root.empty();
    root.addClass("wayfinder-view");
    root.classList.toggle("wf-selecting", this.selectionMode);
    this.hoverCards.clear();
    this.dependencyHover = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleEdges();
      this.positionSelectBar();
    });
    this.resizeObserver.observe(root);

    const configuredRepos = this.configuredRepos;
    const configuredSnapshots = configuredRepos.filter((repo) => this.plugin.snapshots[repo]);
    this.highlightGraph = loadedDependencyGraph(configuredSnapshots.map((repo) => this.plugin.snapshots[repo]));
    if (configuredSnapshots.length === 0) {
      const empty = root.createDiv({ cls: "wf-empty" });
      if (this.plugin.syncing) {
        empty.setText("Syncing…");
        return;
      }
      const errors = this.errorLines();
      if (this.plugin.configError) {
        empty.createDiv({ text: this.plugin.configError, cls: "wf-error" });
      } else if (errors.length > 0) {
        for (const error of errors) empty.createDiv({ text: error, cls: "wf-error" });
      } else {
        empty.createDiv({ text: "No data yet. Configure Settings → Wayfinder, then sync." });
      }
      const btn = empty.createEl("button", { text: "Sync now", cls: "wf-sync-now" });
      btn.addEventListener("click", () => void this.plugin.sync(true));
      return;
    }

    if (configuredRepos.length > 0 && this.shownRepos.length === 0) {
      const model = mergeModels([]);
      renderToolbar(root, model, this.toolbarControls(model));
      root.createDiv({
        cls: "wf-empty",
        text: "All repos hidden — use the repo filter to show one.",
      });
      return;
    }

    const model = this.shownModel();
    const requestedMapKey = this.selectedMapKey;
    const projection = projectView(model, {
      selectedMapKey: requestedMapKey,
      showCompletedMaps: this.showCompletedMaps,
      incompleteTicketsOnly: this.incompleteTicketsOnly,
    });
    if (requestedMapKey !== null && projection.selectedMapKey === null) {
      window.localStorage.removeItem(SELECTED_MAP_KEY);
    }
    const visibleModel = projection.model;
    if (
      projection.selectedMapKey !== null &&
      !this.collapsedOverride.has(projection.selectedMapKey)
    ) {
      this.collapsedOverride.set(projection.selectedMapKey, false);
    }
    this.pruneSelection(visibleModel);
    const anyExpanded = visibleModel.maps.some(
      (map) =>
        !(this.collapsedOverride.get(issueKey(map.repo, map.issue.number)) ??
          map.issue.state === "closed"),
    );
    renderToolbar(
      root,
      model,
      this.toolbarControls(model, visibleModel, projection.selectedMapKey, anyExpanded),
    );
    if (this.plugin.configError) {
      root.createDiv({ text: this.plugin.configError, cls: "wf-error" });
    }
    for (const error of this.errorLines()) root.createDiv({ text: error, cls: "wf-error" });
    this.viewport = root.createDiv({ cls: "wf-viewport", attr: {
      "aria-label": "Map canvas. Drag or scroll to pan; Ctrl/Cmd+wheel or pinch to zoom.",
    } });
    const zoomWrap = this.viewport.createDiv({ cls: "wf-zoom" });
    this.zoomWrap = zoomWrap;
    this.applyTransform(this.transform);
    if (visibleModel.orphans.length > 0) this.renderOrphans(zoomWrap, visibleModel.orphans);
    for (const map of visibleModel.maps) this.renderMap(zoomWrap, map);
    if (visibleModel.maps.length === 0) {
      zoomWrap.createDiv({
        cls: "wf-empty",
        text: this.showCompletedMaps
          ? "No maps found."
          : "No active maps. Show completed maps to view completed work.",
      });
    }
    if (this.selectionMode) this.renderSelectBar(root, visibleModel);

    this.prevUpdated = new Map(
      this.shownRepos.flatMap((repo) =>
        (this.plugin.snapshots[repo]?.issues ?? []).map((issue) => [
          issueKey(repo, issue.number),
          issue.updated_at,
        ]),
      ),
    );
    // Edges need final geometry — draw after layout settles.
    this.scheduleEdges();
  }

  /** True when this issue is new or changed since the previous render. */
  private changedSinceLastRender(repo: string, issue: RawIssue): boolean {
    if (!this.prevUpdated) return false; // first render — nothing to compare
    return this.prevUpdated.get(issueKey(repo, issue.number)) !== issue.updated_at;
  }

  private toggleAllMaps(model: Model, anyExpanded: boolean): void {
    for (const map of model.maps) {
      this.collapsedOverride.set(issueKey(map.repo, map.issue.number), anyExpanded);
    }
    this.render();
  }

  private toolbarControls(
    model: Model,
    visibleModel = model,
    selectedMapKey: string | null = null,
    anyExpanded = false,
  ): ToolbarControls {
    const shown = new Set(this.shownRepos);
    return {
      syncStatusText: this.syncStatusText(model, shown.size),
      selectionMode: this.selectionMode,
      mode: this.mode,
      zoom: this.zoom,
      anyExpanded,
      mapChoices: this.mapChoices(model),
      selectedMapKey,
      showCompletedMaps: this.showCompletedMaps,
      incompleteTicketsOnly: this.incompleteTicketsOnly,
      repos: this.configuredRepos.map((repo) => ({ repo, shown: shown.has(repo) })),
      toggleSelectionMode: () => this.toggleSelectionMode(),
      toggleAllMaps: (expanded: boolean) => this.toggleAllMaps(visibleModel, expanded),
      setZoom: (zoom: number) => this.setZoom(zoom),
      adjustZoom: (factor: number) => this.setZoom(this.zoom * factor),
      setMode: (mode: ViewMode) => this.setViewMode(mode),
      setSelectedMap: (key: string | null) => this.setSelectedMap(key),
      setShowCompletedMaps: (show: boolean) => this.setShowCompletedMaps(show),
      setIncompleteTicketsOnly: (onlyIncomplete: boolean) =>
        this.setIncompleteTicketsOnly(onlyIncomplete),
      toggleRepo: (repo: string) => this.toggleRepo(repo),
      showAllRepos: () => this.showAllRepos(),
      refresh: () => void this.plugin.sync(true),
    };
  }

  private mapChoices(model: Model): MapChoice[] {
    const eligible = this.showCompletedMaps
      ? model.maps
      : model.maps.filter((map) => map.issue.state === "open");
    const multipleRepos = new Set(model.maps.map((map) => map.repo)).size > 1;
    return eligible.map((map) => ({
      key: issueKey(map.repo, map.issue.number),
      label: `${multipleRepos ? `${map.repo} · ` : ""}#${map.issue.number} ${map.issue.title}${
        map.issue.state === "closed" ? " (completed)" : ""
      }`,
    }));
  }

  private errorLines(): string[] {
    const prefixRepo = this.configuredRepos.length > 1;
    return this.configuredRepos.flatMap((repo) => {
      const error = this.plugin.errors[repo];
      return error ? [`${prefixRepo ? `${repo} — ` : ""}${error}`] : [];
    });
  }

  private setViewMode(mode: ViewMode): void {
    this.mode = mode;
    this.render();
  }

  private setSelectedMap(key: string | null): void {
    if (key) {
      window.localStorage.setItem(SELECTED_MAP_KEY, key);
      this.collapsedOverride.set(key, false);
    } else {
      window.localStorage.removeItem(SELECTED_MAP_KEY);
    }
    this.render();
    const head = this.zoomWrap?.querySelector<HTMLElement>(".wf-mapcard");
    if (head) this.navigateTo(head);
  }

  private setShowCompletedMaps(show: boolean): void {
    window.localStorage.setItem(SHOW_COMPLETED_MAPS_KEY, String(show));
    this.render();
  }

  private setIncompleteTicketsOnly(onlyIncomplete: boolean): void {
    window.localStorage.setItem(INCOMPLETE_TICKETS_ONLY_KEY, String(onlyIncomplete));
    this.render();
  }

  private toggleSelectionMode(): void {
    this.selectionMode = !this.selectionMode;
    this.render();
  }

  private pruneSelection(model: Model): void {
    const frontier = new Set(
      model.maps.flatMap((map) =>
        map.tickets
          .filter((ticket) => ticket.frontier)
          .map((ticket) => issueKey(ticket.repo, ticket.issue.number)),
      ),
    );
    for (const key of this.selectedIssues) {
      if (!frontier.has(key)) this.selectedIssues.delete(key);
    }
  }

  private selectedTickets(model: Model): Ticket[] {
    return model.maps.flatMap((map) =>
      map.tickets.filter(
        (ticket) =>
          ticket.frontier && this.selectedIssues.has(issueKey(ticket.repo, ticket.issue.number)),
      ),
    );
  }

  private toggleTicketSelection(ticket: Ticket): void {
    const key = issueKey(ticket.repo, ticket.issue.number);
    if (this.selectedIssues.has(key)) {
      this.selectedIssues.delete(key);
    } else {
      this.selectedIssues.add(key);
    }
    // Keep the clicked surface mounted so a native double-click can finish.
    for (const card of Array.from(this.contentEl.querySelectorAll<HTMLElement>(".wf-ticket"))) {
      if (card.dataset.issueKey !== key) continue;
      card.classList.toggle("wf-selected", this.selectedIssues.has(key));
      card.querySelector(".wf-card-main")?.setAttr("aria-pressed", String(this.selectedIssues.has(key)));
    }
    this.contentEl.querySelector(".wf-selectbar")?.remove();
    this.renderSelectBar(this.contentEl, this.shownModel());
  }

  private renderSelectBar(root: HTMLElement, model: Model): void {
    const selected = this.selectedTickets(model);
    const bar = root.createDiv({ cls: "wf-selectbar" });
    bar.createSpan({ cls: "wf-select-count", text: `${selected.length} selected` });

    const commands = bar.createEl("button", { text: "Copy commands", cls: "mod-cta" });
    commands.disabled = selected.length === 0;
    commands.addEventListener("click", () => {
      void this.preflightAndCopy(
        selected,
        [commands, checklist],
        (ticket) =>
          this.plugin.settings.copyTemplate.replace("{url}", ticket.issue.html_url),
      );
    });

    const checklist = bar.createEl("button", { text: "Copy checklist" });
    checklist.disabled = selected.length === 0;
    checklist.addEventListener("click", () => {
      void this.preflightAndCopy(
        selected,
        [commands, checklist],
        (ticket) =>
          `- [ ] /wayfinder ${ticket.issue.html_url} — #${ticket.issue.number} ${ticket.issue.title} (${ticket.type}, ${ticket.mode})`,
      );
    });

    const clear = bar.createEl("button", { text: "Clear" });
    clear.disabled = selected.length === 0;
    clear.addEventListener("click", () => {
      this.selectedIssues.clear();
      this.render();
    });

    const done = bar.createEl("button", { text: "Done" });
    done.addEventListener("click", () => this.toggleSelectionMode());
    this.positionSelectBar();
  }

  private async preflightAndCopy(
    selected: Ticket[],
    buttons: HTMLButtonElement[],
    lineFor: (ticket: Ticket) => string,
  ): Promise<void> {
    for (const button of buttons) button.disabled = true;
    try {
      const results = new Array<{ ticket: Ticket; result: TakeableVerification }>(selected.length);
      let next = 0;
      const workers = Array.from({ length: Math.min(5, selected.length) }, async () => {
        for (let index = next++; index < selected.length; index = next++) {
          const ticket = selected[index];
          results[index] = {
            ticket,
            result: await this.plugin.verifyTakeable(ticket.repo, ticket.issue.number),
          };
        }
      });
      await Promise.all(workers);

      const verified = results.filter(({ result }) => result.status === "ok");
      const excluded = results
        .filter(({ result }) => result.status !== "ok")
        .map(({ ticket, result }) => {
          const reason =
            result.status === "lost"
              ? result.warning
                  .replace(/^#\d+ was /, "")
                  .replace(/ since the last sync$/, "")
              : "couldn't verify";
          return `#${ticket.issue.number} (${reason})`;
        });
      const suffix = excluded.length > 0 ? ` · excluded ${excluded.join(", ")}` : "";
      if (verified.length === 0) {
        new Notice(`Nothing copied${suffix}`);
        return;
      }

      const text = verified.map(({ ticket }) => lineFor(ticket)).join("\n");
      await navigator.clipboard.writeText(text).then(
        () => new Notice(`Copied ${verified.length}${suffix}`),
        () => new Notice("Copy failed — clipboard unavailable"),
      );
    } finally {
      for (const button of buttons) button.disabled = selected.length === 0;
    }
  }

  private positionSelectBar(): void {
    const bar = this.contentEl.querySelector<HTMLElement>(".wf-selectbar");
    if (!bar) return;
    const rect = this.contentEl.getBoundingClientRect();
    bar.setCssStyles({
      left: `${rect.left + rect.width / 2}px`,
      bottom: `${Math.max(8, window.innerHeight - rect.bottom + 12)}px`,
      maxWidth: `${Math.max(0, rect.width - 32)}px`,
    });
  }

  // ── orphans ──────────────────────────────────────────────────────────────

  private renderOrphans(root: HTMLElement, orphans: Ticket[]): void {
    const box = root.createDiv({ cls: "wf-orphans" });
    box.createDiv({
      cls: "wf-orphans-title",
      text: `⚠ ${orphans.length} wayfinder ticket(s) not attached to any map`,
    });
    for (const t of orphans) {
      const row = box.createDiv({ cls: "wf-orphan-row" });
      row.dataset.issueKey = issueKey(t.repo, t.issue.number);
      const main = row.createDiv({ cls: "wf-card-main wf-orphan-main" });
      main.setAttr("aria-label", `#${t.issue.number} ${t.issue.title}`);
      main.createSpan({ cls: "wf-num", text: `#${t.issue.number}` });
      main.createSpan({ text: t.issue.title });
      main.createSpan({
        cls: "wf-orphan-why",
        text: t.parent === null ? "no “Part of #N” line" : `parent #${t.parent} is not a map`,
      });
      makeInteractive(main, () => {
        this.navigateTo(row);
        new TicketModal(this.app, this.plugin, t, null).open();
      });
    }
  }

  // ── map + tree ───────────────────────────────────────────────────────────

  private renderMap(root: HTMLElement, map: MapTree): void {
    const isClosed = map.issue.state === "closed";
    const mapKey = issueKey(map.repo, map.issue.number);
    const collapsed = this.collapsedOverride.get(mapKey) ?? isClosed;
    const expanded = !collapsed;
    const section = root.createDiv({ cls: `wf-map-section wf-map-${this.mode}` });

    const head = section.createDiv({ cls: "wf-mapcard" });
    const chevron = head.createEl("button", {
      cls: "wf-chevron",
      attr: { "aria-label": expanded ? "Collapse map" : "Expand map" },
    });
    setIcon(chevron, expanded ? "chevron-down" : "chevron-right");
    chevron.addEventListener("click", (e) => {
      e.stopPropagation();
      this.collapsedOverride.set(mapKey, expanded);
      this.render();
    });

    const headMain = head.createDiv({ cls: "wf-card-main wf-mapcard-main" });
    headMain.setAttr("aria-label", `#${map.issue.number} ${map.issue.title}`);
    const row1 = headMain.createDiv({ cls: "wf-row1" });
    row1.createSpan({ cls: "wf-num", text: `#${map.issue.number}` });
    row1.createSpan({ cls: "wf-type wf-type-map", text: "map" });
    if (isClosed) row1.createSpan({ cls: "wf-map-done", text: "✓ complete" });
    headMain.createDiv({ cls: "wf-map-title", text: map.issue.title });
    const prog = headMain.createDiv({ cls: "wf-progress" });
    prog.createSpan({ text: `${map.resolved} / ${map.total} resolved` });
    const bar = prog.createDiv({ cls: "wf-bar" });
    const pct = map.total ? Math.round((map.resolved / map.total) * 100) : 0;
    bar.createDiv({ cls: "wf-bar-fill" }).setCssStyles({ width: `${pct}%` });
    const openTickets = map.tickets.filter((ticket) => ticket.issue.state === "open");
    if (!isClosed && openTickets.length > 0) {
      const takeable = openTickets.filter((ticket) => ticket.frontier).length;
      const blocked = openTickets.filter(
        (ticket) => ticket.unverified || ticket.openBlockers.length > 0,
      ).length;
      const claimed = openTickets.filter(
        (ticket) =>
          !ticket.unverified &&
          ticket.openBlockers.length === 0 &&
          ticket.issue.assignees.length > 0,
      ).length;
      const stats = [
        takeable > 0 ? `${takeable} takeable` : "",
        blocked > 0 ? `${blocked} blocked` : "",
        claimed > 0 ? `${claimed} claimed` : "",
      ].filter(Boolean);
      if (stats.length > 0) {
        headMain.createDiv({ cls: "wf-map-stats", text: stats.join(" · ") });
      }
    }

    if (this.changedSinceLastRender(map.repo, map.issue)) head.addClass("wf-changed");
    addIconActions(head, map.repo, map.issue, this.plugin, () => {
      this.navigateTo(head);
      new TicketModal(this.app, this.plugin, null, map).open();
    });
    makeInteractive(headMain, () => {
      this.collapsedOverride.set(mapKey, expanded);
      this.render();
    });
    this.hoverCards.attach(head, null, map);

    if (!expanded) return;
    if (map.tickets.length === 0) {
      section.createDiv({
        cls: "wf-no-tickets",
        text:
          this.incompleteTicketsOnly && map.total > 0
            ? "No incomplete tickets."
            : "No tickets attached yet.",
      });
      return;
    }

    if (this.mode === "list") {
      renderList(section, map, this.ticketCardOptions());
      return;
    }

    if (this.mode === "tree") {
      const tree = this.renderDependencyTree(section, map);
      this.resizeObserver?.observe(tree);
      return;
    }

    const hybrid = section.createDiv({ cls: "wf-hybrid" });
    const dependencies = hybrid.createDiv({ cls: "wf-hybrid-pane" });
    dependencies.createDiv({ cls: "wf-pane-heading", text: "Dependencies" });
    const tree = this.renderDependencyTree(dependencies, map);
    this.resizeObserver?.observe(tree);
    const actionability = hybrid.createDiv({ cls: "wf-hybrid-pane" });
    actionability.createDiv({ cls: "wf-pane-heading", text: "Actionability" });
    renderList(actionability, map, this.ticketCardOptions());
  }

  private renderDependencyTree(section: HTMLElement, map: MapTree): HTMLElement {
    const snapshots = this.configuredRepos.flatMap((repo) => this.plugin.snapshots[repo] ? [this.plugin.snapshots[repo]] : []);
    return renderTree(section, map, this.ticketCardOptions(), dependencyGraph(map, snapshots),
      (node) => this.openGhost(node),
      (key) => {
        this.dependencySelection = key;
        this.updateDependencyHighlight();
      });
  }

  private ticketCardOptions(): Omit<TicketCardOptions, "asRow"> {
    return {
      app: this.app,
      plugin: this.plugin,
      selectionMode: this.selectionMode,
      selected: (ticket) => this.selectedIssues.has(issueKey(ticket.repo, ticket.issue.number)),
      changed: (ticket) => this.changedSinceLastRender(ticket.repo, ticket.issue),
      makeInteractive,
      attachHover: (element, ticket, map) => this.hoverCards.attach(element, ticket, map),
      select: (ticket) => this.toggleTicketSelection(ticket),
      navigate: (ticket) => this.navigateToTicket(ticket),
    };
  }

}

function storedBoolean(key: string, fallback: boolean): boolean {
  const value = window.localStorage.getItem(key);
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}
