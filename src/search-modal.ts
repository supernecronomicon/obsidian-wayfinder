import { SuggestModal, type App } from "obsidian";
import type { Model } from "./model";
import { mapLabel, searchTickets, type SearchHit } from "./search";

/** Cmd/Ctrl+F picker: type a number or title words, pick a ticket to reveal it. */
export class TicketSearchModal extends SuggestModal<SearchHit> {
  constructor(
    app: App,
    private model: Model,
    private showRepo: boolean,
    private onPick: (hit: SearchHit) => void,
  ) {
    super(app);
    this.setPlaceholder("Search tickets by number or title…");
    this.emptyStateText = "No matching tickets.";
    this.limit = 50;
  }

  getSuggestions(query: string): SearchHit[] {
    return searchTickets(this.model, query);
  }

  renderSuggestion(hit: SearchHit, el: HTMLElement): void {
    el.addClass("wf-search-item");
    const title = el.createDiv({ cls: "wf-search-title" });
    title.createSpan({ cls: "wf-num", text: `#${hit.ticket.issue.number}` });
    title.createSpan({ text: ` ${hit.ticket.issue.title}` });
    if (hit.ticket.issue.state === "closed") {
      title.createSpan({ cls: "wf-search-closed", text: " ✓ resolved" });
    }
    el.createDiv({ cls: "wf-search-map", text: mapLabel(hit, this.showRepo) });
  }

  onChooseSuggestion(hit: SearchHit): void {
    this.onPick(hit);
  }
}
