// Cross-vendor offer dedup: cluster listings of the same physical product so
// search returns one hit per product with an `offers` array. Reuses the entity
// engine's *patterns* (candidate probes, two-band autoLink/suggest thresholds,
// confirm/decline feedback) but none of its tables — cluster state lives as
// columns on the collection table (RFC rfcs/rfc-offer-dedup.md §2).
//
// Clustering is greedy + incremental: each unclustered ready row generates
// candidates (exactKey ∪ trigram top-20 ∪ ANN top-20, all scope-pinned), scores
// its best candidate, and either auto-links (>= autoLink), founds a suggestion
// (>= suggest), or founds its own cluster. Precision-first: uncertain pairs are
// suggestions, never auto-merges. Candidates are pinned to the row's own scope,
// so a cluster can never span tenancy scopes (REQ-5, by construction).
import { clusterBatch } from "@samesake/enrich";
import type { ClusterDecision, DedupCandidate, DedupRow } from "@samesake/enrich";
import type { MatcherCtx } from "../types.ts";
import type { ProjectsService } from "./projects.ts";
import { collectionTableName } from "./db-utils.ts";
import { resolveScope } from "./scope.ts";
import { collectionScopes, scopeColumn, dedupGroupField } from "./collections-schema-gen.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import { searchResultCache } from "./search-cache.ts";

// Scoring + clustering moved to @samesake/enrich (no SQL); re-exported for existing importers.
export { scoreCandidate, scoreBest } from "@samesake/enrich";
export type { DedupCandidate } from "@samesake/enrich";

export interface DedupRunOpts {
  /** Max rows to process this run. Default 500. */
  limit?: number;
  /** Clear all cluster state (groups + open suggestions) and re-cluster; confirmed/declined replayed. */
  rebuild?: boolean;
}

export interface DedupRunResult {
  processed: number;
  autoLinked: number;
  founded: number;
  suggested: number;
}

function parseEmbedding(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    const vector = value.filter((entry): entry is number => typeof entry === "number");
    return vector.length ? vector : null;
  }
  if (typeof value !== "string") return null;
  const values = value.replace(/^[\[{]|[\]}]$/g, "").split(",").map(Number);
  return values.length && values.every(Number.isFinite) ? values : null;
}

export function makeDedupService(ctx: MatcherCtx, projectsService: ProjectsService) {
  function client(context: string) {
    return ctx.storage.client(context);
  }

  async function resolveDedup(projectSlug: string, collectionName: string) {
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await projectsService.getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);
    if (!def.dedup) throw new Error(`collection "${collectionName}" declares no dedup config`);
    const cfg = def.dedup;
    const table = collectionTableName(project.schema_name, collectionName);
    const sugg = `${table}_dedup_suggestions`;
    const group = sanitiseIdent(dedupGroupField(def));
    const scopeCols = collectionScopes(def).map(scopeColumn);
    const channelFields = [
      ...new Set(
        cfg.channels
          .filter((c): c is Extract<typeof c, { field: string }> => c.kind !== "cosine")
          .map((c) => sanitiseIdent(c.field))
      ),
    ];
    return { project, def, cfg, table, sugg, group, scopeCols, channelFields };
  }

  type ResolvedDedup = Awaited<ReturnType<typeof resolveDedup>>;

  function toDedupCandidates(
    r: ResolvedDedup,
    rows: Record<string, unknown>[]
  ): DedupCandidate[] {
    return rows.map((cr) => {
      const fields: Record<string, unknown> = {};
      for (const col of r.channelFields) fields[col] = cr[col];
      const trgm: Record<string, number> = {};
      for (const key of Object.keys(cr).filter((key) => key.startsWith("trgm_"))) {
        const field = key.slice("trgm_".length);
        trgm[field] = cr[key] == null ? 0 : Number(cr[key]);
      }
      return {
        id: String(cr.id),
        group: cr._group == null ? null : String(cr._group),
        fields,
        trgm,
        cos: cr._cos == null ? null : Number(cr._cos),
      };
    });
  }

  // One round trip: exactKey btree ∪ trigram GIN top-20 ∪ ANN top-20, all
  // scope-pinned and excluding the row itself; joined back to fetch raw channel
  // values + per-channel similarities. Only ready rows are candidates.
  async function candidates(
     r: Awaited<ReturnType<typeof resolveDedup>>,
    row: Record<string, unknown>
  ): Promise<DedupCandidate[]> {
    const { table, cfg, group, scopeCols, channelFields } = r;
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const rowIdRef = p(String(row.id));
    const probes: string[] = [];
    // exactKey probes
    for (const ch of cfg.channels) {
      if (ch.kind !== "exactKey") continue;
      const col = sanitiseIdent(ch.field);
      const val = row[col];
      if (val == null || String(val).trim() === "") continue;
      const eq = scopeCols.map((sc) => ` AND ${sc} = ${p(row[sc])}`).join("");
      probes.push(
        `(SELECT id FROM ${table} WHERE ${col} = ${p(String(val))} AND ${col} <> '' AND id <> ${rowIdRef}${eq})`
      );
    }
    // trigram probes — capture the value ref so the outer similarity() reuses it
    const trgmRefs: Record<string, string> = {};
    for (const ch of cfg.channels) {
      if (ch.kind !== "trigram") continue;
      const col = sanitiseIdent(ch.field);
      const val = row[col];
      if (val == null || String(val).trim() === "") continue;
      const ref = p(String(val));
      trgmRefs[col] = ref;
      const eq = scopeCols.map((sc) => ` AND ${sc} = ${p(row[sc])}`).join("");
      probes.push(
        `(SELECT id FROM ${table} WHERE id <> ${rowIdRef}${eq} AND ${col} % ${ref} ORDER BY similarity(${col}, ${ref}) DESC LIMIT 20)`
      );
    }
    // cosine probe
    let vecRef: string | null = null;
    const hasCos = cfg.channels.some((c) => c.kind === "cosine");
    if (hasCos && row._emb != null) {
      vecRef = p(String(row._emb));
      const eq = scopeCols.map((sc) => ` AND ${sc} = ${p(row[sc])}`).join("");
      probes.push(
        `(SELECT id FROM ${table} WHERE id <> ${rowIdRef}${eq} AND embedding IS NOT NULL ORDER BY embedding <=> ${vecRef}::halfvec LIMIT 20)`
      );
    }
    if (probes.length === 0) return [];

    const trgmSelects = Object.entries(trgmRefs).map(
      ([col, ref]) => `similarity(d.${col}, ${ref})::float AS trgm_${col}`
    );
    const cosSelect = vecRef ? `(1 - (d.embedding <=> ${vecRef}::halfvec))::float AS _cos` : `NULL::float AS _cos`;
    const fieldSelects = channelFields.map((col) => `d.${col}`);
    const sql = `
      WITH probe AS (${probes.join(" UNION ")})
      SELECT d.id, d.${group} AS _group${
        [...fieldSelects, ...trgmSelects, cosSelect].length ? ", " + [...fieldSelects, ...trgmSelects, cosSelect].join(", ") : ""
      }
      FROM ${table} d JOIN probe USING (id)
      WHERE d.pipeline_status = 'ready'`;

    const rows = await ctx.storage.dedupCandidateProbe(sql, params);
    return toDedupCandidates(r, rows);
  }

  function toProbeRow(r: ResolvedDedup, row: DedupRow): Record<string, unknown> {
    const probe: Record<string, unknown> = {
      id: row.id,
      _emb: row.embedding?.length ? `[${row.embedding.join(",")}]` : null,
      ...row.fields,
    };
    for (const scopeColumnName of r.scopeCols) {
      const scopeKey = scopeColumnName.startsWith("scope_")
        ? scopeColumnName.slice("scope_".length)
        : scopeColumnName;
      probe[scopeColumnName] = row.scope?.[scopeColumnName] ?? row.scope?.[scopeKey];
    }
    return probe;
  }

  async function applyDecisions(
    r: ResolvedDedup,
    decisions: ClusterDecision[]
  ): Promise<DedupRunResult> {
    const counters: DedupRunResult = { processed: 0, autoLinked: 0, founded: 0, suggested: 0 };
    for (const decision of decisions) {
      if (decision.outcome === "link" && decision.group !== decision.rowId) {
        await client("dedup found-leader").unsafe(
          `UPDATE ${r.table} SET ${r.group} = id WHERE id = $1 AND ${r.group} IS NULL`,
          [decision.group]
        );
      }
      if (decision.outcome === "suggest") {
        if ((await suggestionStatus(r.sugg, decision.rowId, decision.group)) !== "confirmed") {
          await client("dedup suggest").unsafe(
            `INSERT INTO ${r.sugg} (row_id, candidate_group, score, status)
             VALUES ($1, $2, $3, 'open')
             ON CONFLICT (row_id, candidate_group) DO UPDATE SET score = EXCLUDED.score`,
            [decision.rowId, decision.group, decision.score]
          );
        }
      }
      await client("dedup assign").unsafe(
        `UPDATE ${r.table}
         SET ${r.group} = $1, dedup_score = $2, dedup_checked_at = now()
         WHERE id = $3`,
        [decision.outcome === "link" ? decision.group : decision.rowId, decision.score, decision.rowId]
      );
      counters.processed++;
      if (decision.outcome === "link") counters.autoLinked++;
      else if (decision.outcome === "suggest") counters.suggested++;
      else counters.founded++;
    }
    return counters;
  }

  async function suggestionStatus(sugg: string, rowId: string, group: string): Promise<string | null> {
    return ctx.storage.dedupSuggestionStatus(sugg, rowId, group);
  }

  // A split is a SYMMETRIC decision — the two rows must never re-cluster, regardless of
  // which one is the leader when they meet again. Clustering is symmetric but the decline
  // record is one directional (row_id, candidate_group), so check BOTH orderings; otherwise
  // a rebuild that re-founds the cluster the other way silently re-merges the split pair.
  async function isDeclined(sugg: string, a: string, b: string): Promise<boolean> {
    return ctx.storage.dedupIsDeclined(sugg, a, b);
  }

  async function dedup(
    projectSlug: string,
    collectionName: string,
    opts: DedupRunOpts = {}
  ): Promise<DedupRunResult> {
    const r = await resolveDedup(projectSlug, collectionName);
    const { table, sugg, cfg, group, scopeCols, channelFields } = r;

    if (opts.rebuild) {
      await client("dedup rebuild").unsafe(
        `UPDATE ${table} SET ${group} = NULL, dedup_score = NULL, dedup_checked_at = NULL`,
        []
      );
      await client("dedup rebuild").unsafe(`DELETE FROM ${sugg} WHERE status = 'open'`, []);
      // Replay confirmed merges: a human confirm survives rebuild (REQ-10). Sets both
      // member and leader to the confirmed cluster id so the pair stays merged.
      await client("dedup rebuild").unsafe(
        `UPDATE ${table} t SET ${group} = s.candidate_group
         FROM ${sugg} s WHERE s.status = 'confirmed' AND (t.id = s.row_id OR t.id = s.candidate_group)`,
        []
      );
    }

    const selectCols = [
      "id",
      "embedding::text AS _emb",
      ...scopeCols,
      ...channelFields,
    ].join(", ");
    const rows = await client("dedup rows").unsafe(
      `SELECT ${selectCols} FROM ${table}
       WHERE ${group} IS NULL AND pipeline_status = 'ready' AND indexed_at IS NOT NULL
       ORDER BY ingested_at
       LIMIT $1`,
      [opts.limit ?? 500]
    );

    const dedupRows: DedupRow[] = rows.map((row) => ({
      id: String(row.id),
      fields: Object.fromEntries(channelFields.map((field) => [field, row[field]])),
      embedding: parseEmbedding(row._emb),
      scope: Object.fromEntries(scopeCols.map((field) => [field, String(row[field])])),
    }));
    const provider = (row: DedupRow) => candidates(r, toProbeRow(r, row));
    const feedback = {
      isDeclined: (a: string, b: string) => isDeclined(sugg, a, b),
      suggestionStatus: (rowId: string, targetGroup: string) => suggestionStatus(sugg, rowId, targetGroup),
    };
    const decisions = await clusterBatch(cfg, dedupRows, provider, feedback);
    const counters = await applyDecisions(r, decisions);

    searchResultCache.invalidateProjectCollection(projectSlug, collectionName);
    return counters;
  }

  // ── Human loop ──────────────────────────────────────────────────────────
  async function dedupClusters(
    projectSlug: string,
    collectionName: string,
    opts: { scope?: Record<string, string>; minMembers?: number; limit?: number } = {}
  ): Promise<{ clusters: Array<{ group: string; members: Array<Record<string, unknown>> }> }> {
    const r = await resolveDedup(projectSlug, collectionName);
    const scopeVals = resolveScope(r.def, collectionName, opts.scope, "dedupClusters");
    const minMembers = opts.minMembers ?? 2;
    const limit = opts.limit ?? 100;
    const cfg = r.cfg;
    const offerCols = cfg.offerFields.map((f) => sanitiseIdent(f));
    const selCols = [...new Set(["id", ...r.channelFields, ...offerCols])].map((c) => `d.${c}`).join(", ");

    // Pick the top-N qualifying clusters in SQL first (bounded), then fetch only THOSE
    // members — never materialize the whole clustered table for a paged admin view.
    const params: unknown[] = [];
    let scopeEq = "";
    for (const [col, val] of Object.entries(scopeVals)) {
      params.push(val);
      scopeEq += ` AND d.${col} = $${params.length}`;
    }
    params.push(minMembers);
    const mmRef = `$${params.length}`;
    params.push(limit);
    const limRef = `$${params.length}`;
    const rows = await client("dedup clusters").unsafe(
      `WITH grp AS (
         SELECT d.${r.group} AS g, count(*) AS n FROM ${r.table} d
         WHERE d.${r.group} IS NOT NULL AND d.pipeline_status = 'ready'${scopeEq}
         GROUP BY d.${r.group} HAVING count(*) >= ${mmRef}
         ORDER BY n DESC LIMIT ${limRef}
       )
       SELECT d.${r.group} AS _group, ${selCols} FROM ${r.table} d
       JOIN grp ON d.${r.group} = grp.g
       WHERE d.pipeline_status = 'ready'
       ORDER BY d.${r.group}, d.ingested_at`,
      params
    );

    const byGroup = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const g = String(row._group);
      const member: Record<string, unknown> = { id: String(row.id) };
      for (const c of [...r.channelFields, ...offerCols]) member[c] = row[c];
      const list = byGroup.get(g) ?? [];
      list.push(member);
      byGroup.set(g, list);
    }
    const clusters = [...byGroup.entries()].map(([group, members]) => ({ group, members }));
    return { clusters };
  }

  async function dedupSuggestions(
    projectSlug: string,
    collectionName: string,
    opts: { scope?: Record<string, string>; limit?: number } = {}
  ): Promise<{ suggestions: Array<{ id: string; candidateGroup: string; score: number }> }> {
    const r = await resolveDedup(projectSlug, collectionName);
    const scopeVals = resolveScope(r.def, collectionName, opts.scope, "dedupSuggestions");
    const limit = opts.limit ?? 100;
    const params: unknown[] = [];
    let scopeEq = "";
    for (const [col, val] of Object.entries(scopeVals)) {
      params.push(val);
      scopeEq += ` AND t.${col} = $${params.length}`;
    }
    params.push(limit);
    const rows = await client("dedup suggestions").unsafe(
      `SELECT s.row_id, s.candidate_group, s.score
       FROM ${r.sugg} s JOIN ${r.table} t ON t.id = s.row_id
       WHERE s.status = 'open'${scopeEq}
       ORDER BY s.score DESC LIMIT $${params.length}`,
      params
    );
    return {
      suggestions: rows.map((row) => ({
        id: String(row.row_id),
        candidateGroup: String(row.candidate_group),
        score: Number(row.score),
      })),
    };
  }

  async function confirmGroup(
    projectSlug: string,
    collectionName: string,
    input: { id: string; group: string; scope?: Record<string, string> }
  ): Promise<{ confirmed: true }> {
    const r = await resolveDedup(projectSlug, collectionName);
    const scopeVals = resolveScope(r.def, collectionName, input.scope, "confirmGroup");
    const scopeEq = Object.entries(scopeVals);

    // The target cluster must have a ready member in scope (else there is nothing to merge into).
    const gParams: unknown[] = [input.group, input.group];
    let gScope = "";
    for (const [col, val] of scopeEq) {
      gParams.push(val);
      gScope += ` AND ${col} = $${gParams.length}`;
    }
    const exists = await client("dedup confirm check").unsafe(
      `SELECT 1 FROM ${r.table} WHERE (${r.group} = $1 OR id = $2) AND pipeline_status = 'ready'${gScope} LIMIT 1`,
      gParams
    );
    if (!exists.length) {
      throw new Error(`confirmGroup: cluster "${input.group}" has no ready member in this scope`);
    }

    const setScope = (base: string, idParam: string, extra: unknown[]): { sql: string; params: unknown[] } => {
      const params = [...extra];
      let where = base;
      for (const [col, val] of scopeEq) {
        params.push(val);
        where += ` AND ${col} = $${params.length}`;
      }
      return { sql: where, params };
    };

    // Leader founds itself if not yet clustered.
    const leader = setScope(`UPDATE ${r.table} SET ${r.group} = id WHERE id = $1 AND ${r.group} IS NULL`, "$1", [
      input.group,
    ]);
    await client("dedup confirm leader").unsafe(leader.sql, leader.params);

    // Merge the confirmed row into the cluster.
    const merge = setScope(`UPDATE ${r.table} SET ${r.group} = $1 WHERE id = $2`, "$2", [input.group, input.id]);
    await client("dedup confirm merge").unsafe(merge.sql, merge.params);

    // Durable confirm: survives rebuild replay (REQ-10).
    await client("dedup confirm record").unsafe(
      `INSERT INTO ${r.sugg} (row_id, candidate_group, score, status)
       VALUES ($1, $2, COALESCE((SELECT dedup_score FROM ${r.table} WHERE id = $1), 1), 'confirmed')
       ON CONFLICT (row_id, candidate_group) DO UPDATE SET status = 'confirmed'`,
      [input.id, input.group]
    );

    searchResultCache.invalidateProjectCollection(projectSlug, collectionName);
    return { confirmed: true };
  }

  async function splitGroup(
    projectSlug: string,
    collectionName: string,
    input: { id: string; scope?: Record<string, string> }
  ): Promise<{ group: string }> {
    const r = await resolveDedup(projectSlug, collectionName);
    const scopeVals = resolveScope(r.def, collectionName, input.scope, "splitGroup");

    const readParams: unknown[] = [input.id];
    let readScope = "";
    for (const [col, val] of Object.entries(scopeVals)) {
      readParams.push(val);
      readScope += ` AND ${col} = $${readParams.length}`;
    }
    const cur = await client("dedup split read").unsafe(
      `SELECT ${r.group} AS g, dedup_score FROM ${r.table} WHERE id = $1${readScope} LIMIT 1`,
      readParams
    );
    if (!cur.length) throw new Error(`splitGroup: row "${input.id}" not found in this scope`);
    const oldGroup = cur[0]!.g == null ? null : String(cur[0]!.g);
    const score = cur[0]!.dedup_score == null ? null : Number(cur[0]!.dedup_score);

    // Append the scope equality clause to a params array (returns the ` AND …` string).
    const withScope = (params: unknown[]): string => {
      let s = "";
      for (const [col, val] of Object.entries(scopeVals)) {
        params.push(val);
        s += ` AND ${col} = $${params.length}`;
      }
      return s;
    };

    // Every former co-member of input.id's cluster, captured BEFORE eviction. The decline is
    // recorded against ALL of them (not just the leader) so no rebuild — whatever leader it
    // re-elects — can re-merge input.id with any row a human pulled it away from (REQ-7/10).
    let coMembers: string[] = [];
    if (oldGroup) {
      const cmParams: unknown[] = [oldGroup, input.id];
      const cmScope = withScope(cmParams);
      const cm = await client("dedup split co-members").unsafe(
        `SELECT id FROM ${r.table} WHERE ${r.group} = $1 AND id <> $2${cmScope} ORDER BY ingested_at`,
        cmParams
      );
      coMembers = cm.map((x) => String(x.id));
    }

    // When input.id is the cluster LEADER (group == own id), a plain SET group = id is a no-op —
    // the members would stay attached. Re-home them onto a new leader first so eviction bites.
    if (oldGroup === input.id && coMembers.length) {
      const newLeader = coMembers[0]!;
      const rhParams: unknown[] = [newLeader, oldGroup, input.id];
      const rhScope = withScope(rhParams);
      await client("dedup split rehome").unsafe(
        `UPDATE ${r.table} SET ${r.group} = $1 WHERE ${r.group} = $2 AND id <> $3${rhScope}`,
        rhParams
      );
    }
    // Evict input.id into a fresh cluster of its own.
    const eParams: unknown[] = [input.id];
    await client("dedup split evict").unsafe(
      `UPDATE ${r.table} SET ${r.group} = id WHERE id = $1${withScope(eParams)}`,
      eParams
    );

    for (const m of coMembers) {
      await client("dedup split decline").unsafe(
        `INSERT INTO ${r.sugg} (row_id, candidate_group, score, status)
         VALUES ($1, $2, $3, 'declined')
         ON CONFLICT (row_id, candidate_group) DO UPDATE SET status = 'declined'`,
        [input.id, m, score ?? 0]
      );
    }

    searchResultCache.invalidateProjectCollection(projectSlug, collectionName);
    return { group: input.id };
  }

  return { dedup, dedupClusters, dedupSuggestions, confirmGroup, splitGroup };
}

export type DedupService = ReturnType<typeof makeDedupService>;
