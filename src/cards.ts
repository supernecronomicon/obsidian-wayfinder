import { Menu, setIcon, type App } from "obsidian";
import type WayfinderPlugin from "./main";
import { TicketModal } from "./modal";
import {
  blockerLabel,
  issueKey,
  type MapTree,
  type PriorityLevel,
  type RawIssue,
  type Ticket,
} from "./model";

export interface TicketCardOptions {
  app: App;
  plugin: WayfinderPlugin;
  asRow?: boolean;
  selectionMode: boolean;
  selected(ticket: Ticket): boolean;
  changed(ticket: Ticket): boolean;
  makeInteractive(el: HTMLElement, activate: () => void, open?: () => void): void;
  attachHover(el: HTMLElement, ticket: Ticket, map: MapTree): void;
  select(ticket: Ticket): void;
  activateTicket?(ticket: Ticket): void;
}

/** Shared ticket card used by both tree layers and list groups. */
export function renderTicketCard(
  root: HTMLElement,
  ticket: Ticket,
  map: MapTree,
  options: TicketCardOptions,
): void {
  const card = root.createDiv({
    cls: `wf-ticket wf-t-${ticket.type}${options.asRow ? " wf-ticket-row" : ""}`,
  });
  card.dataset.issue = String(ticket.issue.number);
  card.dataset.issueKey = issueKey(ticket.repo, ticket.issue.number);
  const closed = ticket.issue.state === "closed";
  const blocked = !closed && ticket.openBlockers.length > 0;
  if (closed) card.addClass("wf-closed");
  if (blocked) card.addClass("wf-blocked");
  if (ticket.frontier) {
    card.addClass("wf-frontier");
    card.createSpan({ cls: "wf-frontier-flag", text: "FRONTIER" });
  }
  const main = card.createDiv({ cls: "wf-card-main" });
  main.setAttr("aria-label", `#${ticket.issue.number} ${ticket.issue.title}`);

  if (options.selectionMode && ticket.frontier) {
    const selected = options.selected(ticket);
    main.setAttr("aria-pressed", String(selected));
    if (selected) card.addClass("wf-selected");
  }

  const row1 = main.createDiv({ cls: "wf-row1" });
  row1.createSpan({ cls: "wf-num", text: `#${ticket.issue.number}` });
  row1.createSpan({ cls: "wf-type", text: ticket.type });
  renderPriorityBadge(row1, ticket);
  row1.createSpan({
    cls: `wf-mode wf-mode-${ticket.mode.toLowerCase()}`,
    text: ticket.mode,
  });

  main.createDiv({ cls: "wf-ticket-title", text: ticket.issue.title });

  let metaText: string;
  if (closed) {
    metaText = "✓ resolved";
  } else if (ticket.unverified) {
    metaText = "⚠ blockers unverified";
  } else if (blocked) {
    metaText = `🔒 blocked by ${ticket.openBlockers.map(blockerLabel).join(" ")}`;
  } else if (ticket.issue.assignees.length > 0) {
    const idle = claimedIdleAge(ticket.issue.updated_at);
    metaText = `● claimed by ${ticket.issue.assignees.join(", ")}${idle ? ` · idle ${idle}` : ""}`;
  } else {
    metaText = "● open · takeable now";
  }
  if (!closed && ticket.downstreamImpact > 0) {
    metaText += ` · unblocks ${ticket.downstreamImpact}`;
  }
  const statusClass = blocked ? " wf-status-blocked" : ticket.frontier ? " wf-status-open" : "";
  main.createDiv({ cls: `wf-meta${statusClass}`, text: metaText });

  const openDetails = (): void => new TicketModal(options.app, options.plugin, ticket, map).open();
  if (options.changed(ticket)) card.addClass("wf-changed");
  addIconActions(card, ticket.repo, ticket.issue, options.plugin,
    options.activateTicket ? openDetails : undefined,
    ticket.frontier);
  options.makeInteractive(main, () => {
    if (options.selectionMode && ticket.frontier) {
      options.select(ticket);
      return;
    }
    if (options.activateTicket) {
      options.activateTicket(ticket);
      return;
    }
    openDetails();
  }, options.activateTicket ? () => {
    if (options.selectionMode && ticket.frontier && !options.selected(ticket)) {
      options.select(ticket);
    }
    options.activateTicket!(ticket);
    openDetails();
  } : undefined);
  options.attachHover(card, ticket, map);
  card.addEventListener("contextmenu", (event) => {
    if (!options.plugin.canSetPriority(ticket.repo)) return;
    event.preventDefault();
    showPriorityMenu(event, ticket, options.plugin);
  });
}

function renderPriorityBadge(row: HTMLElement, ticket: Ticket): void {
  const priority = ticket.priority;
  if (!priority) return;
  const badge = row.createSpan({
    cls: `wf-priority wf-priority-p${priority.level}`,
    text: `P${priority.level}`,
  });
  if (priority.conflicting.length > 0) {
    badge.createSpan({ cls: "wf-priority-conflict", text: "!" });
    badge.setAttr("aria-label", `Conflicting priority labels: ${priority.conflicting.join(", ")}`);
  }
}

function showPriorityMenu(event: MouseEvent, ticket: Ticket, plugin: WayfinderPlugin): void {
  const busy = plugin.isSettingPriority(ticket.repo, ticket.issue.number);
  const levels: (PriorityLevel | null)[] = [0, 1, 2, 3, null];
  const menu = new Menu();
  for (const level of levels) {
    menu.addItem((item) =>
      item
        .setTitle(level === null ? "Set priority: none" : `Set priority: P${level}`)
        .setChecked(
          level === null
            ? ticket.priority === null
            : ticket.priority?.level === level && ticket.priority.conflicting.length === 0,
        )
        .setDisabled(busy)
        .onClick(() => void plugin.setPriority(ticket.repo, ticket.issue.number, level)),
    );
  }
  menu.showAtMouseEvent(event);
}

/**
 * Small always-available actions on a card: optional ⓘ details, ⧉ copy,
 * ↗ GitHub. Frontier ticket actions use the plugin's live claim guard.
 */
export function addIconActions(
  card: HTMLElement,
  repo: string,
  issue: RawIssue,
  plugin: WayfinderPlugin,
  onInfo?: () => void,
  claimCheck = false,
): void {
  const actions = card.createDiv({ cls: "wf-actions" });
  if (onInfo) {
    const info = actions.createEl("button", {
      cls: "wf-iconbtn",
      attr: { "aria-label": "Show details" },
    });
    setIcon(info, "info");
    info.addEventListener("click", (event) => {
      event.stopPropagation();
      onInfo();
    });
  }

  const guarded = async (action: () => void, overrideLabel: string): Promise<void> => {
    if (claimCheck) {
      await plugin.guardedAction(repo, issue.number, action, overrideLabel);
      return;
    }
    action();
  };

  const copy = actions.createEl("button", {
    cls: "wf-iconbtn",
    attr: { "aria-label": "Copy /wayfinder command" },
  });
  setIcon(copy, "copy");
  copy.addEventListener("click", (event) => {
    event.stopPropagation();
    void guarded(() => plugin.copyCommand(issue.html_url), "Copy anyway");
  });

  const open = actions.createEl("a", {
    cls: "wf-iconbtn",
    href: issue.html_url,
    attr: { "aria-label": "Open on GitHub" },
  });
  setIcon(open, "external-link");
  open.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!claimCheck) return;
    event.preventDefault();
    void guarded(() => window.open(issue.html_url, "_blank"), "Open anyway");
  });
}

function claimedIdleAge(updatedAt: string): string | null {
  const elapsed = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(elapsed) || elapsed <= 24 * 60 * 60 * 1000) return null;
  const hours = Math.round(elapsed / (60 * 60 * 1000));
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}
