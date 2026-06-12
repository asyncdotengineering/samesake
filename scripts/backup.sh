#!/usr/bin/env bash
# samesake backup — pg_dump the database to a timestamped compressed file.
#
# Usage (cron-friendly):
#   ./scripts/backup.sh
#   ./scripts/backup.sh /custom/backup/dir
#
# What it captures:
#   - All per-project schemas (project_*)
#   - The system tables (samesake_embed_cache, samesake_projects, etc.)
#   - The pgboss schema (queue history)
#
# Restore:
#   gunzip -c backup-YYYYMMDD-HHMMSS.sql.gz | psql $SAMESAKE_DATABASE_URL
#
# Important: the four extensions (vector, pg_trgm, unaccent, fuzzystrmatch)
# must already be installed on the target Postgres before restore. The dump
# includes CREATE EXTENSION statements but they only work if the extensions
# are available in the target.

set -euo pipefail

BACKUP_DIR="${1:-./backups}"
mkdir -p "$BACKUP_DIR"

TS=$(date -u +%Y%m%d-%H%M%S)
OUT="${BACKUP_DIR}/samesake-${TS}.sql.gz"

# Detect environment: prefer docker-compose flow (most users), fall back to
# direct SAMESAKE_DATABASE_URL.
if docker compose ps postgres >/dev/null 2>&1 \
  && [ -n "$(docker compose ps -q postgres 2>/dev/null)" ]; then
  echo "[backup] using docker compose postgres container"
  docker compose exec -T postgres pg_dump \
    -U samesake \
    -d samesake_dev \
    --no-owner \
    --no-privileges \
    --clean \
    --if-exists \
    | gzip -9 > "$OUT"
elif [ -n "${SAMESAKE_DATABASE_URL:-}" ]; then
  echo "[backup] using SAMESAKE_DATABASE_URL"
  pg_dump "$SAMESAKE_DATABASE_URL" \
    --no-owner \
    --no-privileges \
    --clean \
    --if-exists \
    | gzip -9 > "$OUT"
else
  echo "[backup] ERROR: no docker compose postgres found and SAMESAKE_DATABASE_URL not set" >&2
  exit 1
fi

SIZE=$(du -h "$OUT" | cut -f1)
echo "[backup] wrote ${OUT} (${SIZE})"

# Retention: keep last 14 daily backups
KEEP=14
TOTAL=$(ls -1 "$BACKUP_DIR"/samesake-*.sql.gz 2>/dev/null | wc -l | tr -d ' ')
if [ "$TOTAL" -gt "$KEEP" ]; then
  REMOVE=$((TOTAL - KEEP))
  echo "[backup] retention: removing oldest $REMOVE backups (keeping last $KEEP)"
  ls -1t "$BACKUP_DIR"/samesake-*.sql.gz | tail -n "$REMOVE" | xargs rm -f
fi
