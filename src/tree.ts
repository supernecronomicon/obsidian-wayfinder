import { renderTicketCard, type TicketCardOptions } from "./cards";
import { dependencyClosure, issueKey, type DependencyGraph, type DependencyNode, type MapTree } from "./model";

const graphs = new WeakMap<HTMLElement, DependencyGraph>();

export function renderTree(
  section: HTMLElement,
  map: MapTree,
  cardOptions: Omit<TicketCardOptions, "asRow">,
  graph: DependencyGraph,
  openGhost: (node: DependencyNode) => void,
  selectNode: (key: string) => void,
): HTMLElement {
  const scroller = section.createDiv({ cls: "wf-tree-scroll" });
  scroller.dataset.mapKey = issueKey(map.repo, map.issue.number);
  const tree = scroller.createDiv({ cls: "wf-tree" });
  graphs.set(tree, graph);
  const svg = tree.createSvg("svg", { cls: "wf-edges" });
  svg.setAttr("aria-hidden", "true");

  const ghosts = graph.nodes.filter((node) => node.ghost);
  const ghostKeys = new Set(ghosts.map((node) => node.key));
  const blockers = new Set(graph.edges.filter((edge) => ghostKeys.has(edge.from)).map((edge) => edge.from));
  const renderGhosts = (nodes: DependencyNode[], label: string): void => {
    if (nodes.length === 0) return;
    const layer = tree.createDiv({ cls: "wf-layer wf-ghost-layer", attr: { "aria-label": label } });
    for (const node of nodes) {
      const container = node.state === "closed" ? layer.createDiv({ cls: "wf-closed-backing" }) : layer;
      const card = container.createDiv({ cls: `wf-ticket wf-ghost${node.state === "closed" ? " wf-closed" : ""}` });
      card.dataset.issueKey = node.key;
      const main = card.createDiv({ cls: "wf-card-main" });
      const location = node.map ? `#${node.map.number} ${node.map.title} · ${node.repo}` : node.repo;
      main.setAttr("aria-label", `#${node.number} ${node.title}, ${node.state}, ${location}`);
      const row = main.createDiv({ cls: "wf-row1" });
      row.createSpan({ cls: "wf-num", text: `#${node.number}` });
      row.createSpan({
        cls: `wf-ghost-state${node.state === "open" ? " wf-status-open" : ""}`,
        text: node.state === "open" ? "● open" : node.state,
      });
      main.createDiv({ cls: "wf-ticket-title", text: node.title });
      main.createDiv({ cls: "wf-ghost-location", text: location });
      main.setAttr("title", "Click or Enter/Space to highlight all upstream/downstream dependencies · Double-click or Shift+Enter to navigate to this ticket · Esc clears highlight");
      cardOptions.makeInteractive(main, () => selectNode(node.key), () => {
        selectNode(node.key);
        openGhost(node);
      });
    }
  };
  renderGhosts(ghosts.filter((node) => blockers.has(node.key)), "External blockers");
  for (const layer of map.layers) {
    const layerEl = tree.createDiv({ cls: "wf-layer" });
    for (const ticket of layer) renderTicketCard(layerEl, ticket, map, {
      ...cardOptions,
      activateTicket: (ticket) => selectNode(issueKey(ticket.repo, ticket.issue.number)),
    });
  }
  renderGhosts(ghosts.filter((node) => !blockers.has(node.key)), "External dependants");
  return tree;
}

export function drawAllEdges(root: HTMLElement): void {
  for (const tree of Array.from(root.querySelectorAll<HTMLElement>(".wf-tree"))) {
    const graph = graphs.get(tree);
    if (graph) drawEdges(tree, graph);
  }
}

function drawEdges(tree: HTMLElement, graph: DependencyGraph): void {
  const svg = tree.querySelector<SVGSVGElement>("svg.wf-edges");
  if (!svg) return;
  const treeRect = tree.getBoundingClientRect();
  if (treeRect.width === 0) return;
  svg.setAttr("viewBox", `0 0 ${treeRect.width} ${treeRect.height}`);
  svg.empty();
  const cards = new Map<string, HTMLElement>();
  for (const card of Array.from(tree.querySelectorAll<HTMLElement>(".wf-ticket"))) {
    cards.set(card.dataset.issueKey!, card);
  }
  for (const edge of graph.edges) {
    const from = cards.get(edge.from);
    const to = cards.get(edge.to);
    if (!from || !to) continue;
    const path = drawEdge(svg, treeRect, from, to);
    path.dataset.from = edge.from;
    path.dataset.to = edge.to;
    if (edge.ghost) path.classList.add("wf-edge-ghost");
  }
}

function drawEdge(svg: SVGSVGElement, treeRect: DOMRect, from: HTMLElement, to: HTMLElement): SVGPathElement {
  const source = from.getBoundingClientRect();
  const target = to.getBoundingClientRect();
  const x1 = source.left + source.width / 2 - treeRect.left;
  const y1 = source.bottom - treeRect.top;
  const x2 = target.left + target.width / 2 - treeRect.left;
  const y2 = target.top - treeRect.top;
  const middleY = (y2 - y1) / 2;
  const path = svg.createSvg("path");
  if (target.top <= source.top) {
    // Cycles (including a ghost that is both blocker and dependant) route
    // around the cards rather than back through their titles.
    const right1 = source.right - treeRect.left;
    const right2 = target.right - treeRect.left;
    const side = Math.max(right1, right2) + 20;
    const mid1 = source.top + source.height / 2 - treeRect.top;
    const mid2 = target.top + target.height / 2 - treeRect.top;
    path.setAttr("d", `M ${right1} ${mid1} C ${side} ${mid1}, ${side} ${mid2}, ${right2} ${mid2}`);
  } else {
    path.setAttr("d", `M ${x1} ${y1} C ${x1} ${y1 + middleY}, ${x2} ${y2 - middleY}, ${x2} ${y2}`);
  }
  path.setAttr("fill", "none");
  path.setAttr("class", `wf-edge ${to.hasClass("wf-frontier") ? "wf-edge-frontier" : to.hasClass("wf-closed") ? "wf-edge-closed" : "wf-edge-open"}`);
  if (to.hasClass("wf-blocked")) path.classList.add("wf-edge-blocked");
  return path;
}

/** Resolve against loaded data, not only edges whose endpoints are currently drawn. */
export function highlightDependencies(root: HTMLElement, key: string | null, graph: DependencyGraph): void {
  const neighbours = key === null ? new Set<string>() : dependencyClosure(graph, key);
  for (const edge of Array.from(root.querySelectorAll<SVGPathElement>(".wf-edge"))) {
    const active = neighbours.has(edge.dataset.from!) && neighbours.has(edge.dataset.to!);
    edge.classList.toggle("wf-dependency-active", active);
    edge.classList.toggle("wf-dependency-dim", key !== null && !active);
  }
  for (const card of Array.from(root.querySelectorAll<HTMLElement>(".wf-ticket"))) {
    const active = neighbours.has(card.dataset.issueKey ?? "");
    card.classList.toggle("wf-dependency-active", key !== null && active);
    card.classList.toggle("wf-dependency-dim", key !== null && !active);
    card.classList.toggle("wf-dependency-selected", key !== null && card.dataset.issueKey === key);
  }
}
