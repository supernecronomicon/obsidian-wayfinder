import type { MapTree, Model, Ticket } from "./model";

/** A ticket matching a search, with the map it belongs to (null for an orphan). */
export interface SearchHit {
  ticket: Ticket;
  map: MapTree | null;
}

const MAX_HITS = 50;

/**
 * Find tickets by number ("123", "#123") or by title words (every word must
 * appear, case-insensitive). Exact number matches come first, then open
 * tickets before closed ones, newest first.
 */
export function searchTickets(model: Model, query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [
    ...model.maps.flatMap((map) => map.tickets.map((ticket) => ({ ticket, map }))),
    ...model.orphans.map((ticket) => ({ ticket, map: null })),
  ];
  const number = /^#?(\d+)$/.exec(q)?.[1];
  const words = q.split(/\s+/);
  const matches = hits.filter(({ ticket }) => {
    if (number !== undefined) return String(ticket.issue.number).startsWith(number);
    const haystack = `#${ticket.issue.number} ${ticket.issue.title}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  const exact = (hit: SearchHit): number =>
    number !== undefined && String(hit.ticket.issue.number) === number ? 0 : 1;
  return matches
    .sort(
      (a, b) =>
        exact(a) - exact(b) ||
        (a.ticket.issue.state === b.ticket.issue.state
          ? 0
          : a.ticket.issue.state === "open" ? -1 : 1) ||
        b.ticket.issue.number - a.ticket.issue.number ||
        a.ticket.repo.localeCompare(b.ticket.repo),
    )
    .slice(0, MAX_HITS);
}

/** Human label for where a hit lives: its map, or that it has none. */
export function mapLabel(hit: SearchHit, showRepo: boolean): string {
  const repo = showRepo ? `${hit.ticket.repo} · ` : "";
  if (!hit.map) return `${repo}not in any map`;
  return `${repo}in map #${hit.map.issue.number} ${hit.map.issue.title}${
    hit.map.issue.state === "closed" ? " (completed)" : ""
  }`;
}
