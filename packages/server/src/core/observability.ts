export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerEvent {
  level: LogLevel;
  scope: string;
  msg: string;
  fields?: Record<string, unknown>;
}

export type LoggerFn = (event: LoggerEvent) => void;

export interface MetricsSnapshot {
  searches_total: number;
  search_cache_hits: number;
  search_cutoff_dropped_total: number;
  nlq_cache_hits: number;
  nlq_degraded_total: number;
  enrich_docs_total: number;
  enrich_failures_total: number;
  embed_calls_total: number;
  embed_cache_hits: number;
  index_docs_total: number;
}

export type MetricName = keyof MetricsSnapshot;

const SECRET_KEYS = /key|token|secret|password|authorization|api_key/i;

function truncateValue(v: unknown, depth = 0): unknown {
  if (depth > 3) return "[truncated]";
  if (typeof v === "string") {
    if (v.length > 200) return `${v.slice(0, 200)}…`;
    return v;
  }
  if (Array.isArray(v)) {
    return v.slice(0, 20).map((x) => truncateValue(x, depth + 1));
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEYS.test(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = truncateValue(val, depth + 1);
      }
    }
    return out;
  }
  return v;
}

function sanitizeFields(fields?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!fields || !Object.keys(fields).length) return undefined;
  return truncateValue(fields) as Record<string, unknown>;
}

function defaultLogger(event: LoggerEvent): void {
  if (event.level === "debug" || event.level === "info") return;
  const suffix = event.fields ? ` ${JSON.stringify(event.fields)}` : "";
  const line = `[${event.scope}] ${event.msg}${suffix}`;
  if (event.level === "error") console.error(line);
  else console.warn(line);
}

export interface Observability {
  log(level: LogLevel, scope: string, msg: string, fields?: Record<string, unknown>): void;
  inc(name: MetricName, by?: number): void;
  metrics(): MetricsSnapshot;
}

export function createObservability(config?: { logger?: LoggerFn }): Observability {
  const counters: MetricsSnapshot = {
    searches_total: 0,
    search_cache_hits: 0,
    search_cutoff_dropped_total: 0,
    nlq_cache_hits: 0,
    nlq_degraded_total: 0,
    enrich_docs_total: 0,
    enrich_failures_total: 0,
    embed_calls_total: 0,
    embed_cache_hits: 0,
    index_docs_total: 0,
  };

  const logger = config?.logger ?? defaultLogger;

  return {
    log(level, scope, msg, fields) {
      logger({ level, scope, msg, fields: sanitizeFields(fields) });
    },
    inc(name, by = 1) {
      counters[name] += by;
    },
    metrics() {
      return { ...counters };
    },
  };
}
