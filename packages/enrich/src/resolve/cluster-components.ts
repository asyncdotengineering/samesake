import Graph from "graphology";
import { connectedComponents } from "graphology-components";

export interface ScoredPair {
  a: string;
  b: string;
  Pr: number;
}

/**
 * In-memory batch connected-components clustering (graphology).
 * At 100M scale this is replaced by incremental persisted union-find (write entity_id, no whole-graph hold).
 */
export function clusterByComponents(
  nodes: string[],
  pairs: ScoredPair[],
  tau: number
): string[][] {
  const g = new Graph({ type: "undirected", allowSelfLoops: false });
  for (const n of nodes) {
    if (!g.hasNode(n)) g.addNode(n);
  }
  for (const p of pairs) {
    if (p.Pr < tau) continue;
    if (!g.hasNode(p.a) || !g.hasNode(p.b)) continue;
    if (p.a === p.b) continue;
    if (!g.hasEdge(p.a, p.b)) g.addEdge(p.a, p.b);
  }
  return connectedComponents(g)
    .filter((c) => c.length > 1)
    .map((c) => [...c].sort((x, y) => x.localeCompare(y)))
    .sort((a, b) => a[0]!.localeCompare(b[0]!));
}
