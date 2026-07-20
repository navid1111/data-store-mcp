#!/usr/bin/env bash
#
# Downloads the Pagila (PostgreSQL) and Sakila (MySQL) sample databases into
# fixtures/, laid out so the official Docker images load them automatically via
# /docker-entrypoint-initdb.d. Files are numbered because both entrypoints run
# *.sql in alphabetical order and schema must precede data.
#
# Idempotent: skips anything already downloaded. Pass --force to re-download.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$ROOT/fixtures"
PAGILA_RAW="https://raw.githubusercontent.com/devrimgunduz/pagila/master"
SAKILA_TGZ="https://downloads.mysql.com/docs/sakila-db.tar.gz"

[[ "${1:-}" == "--force" ]] && rm -rf "$FIXTURES"

mkdir -p "$FIXTURES/postgres" "$FIXTURES/mysql"

fetch() {
  local url="$1" dest="$2"
  if [[ -s "$dest" ]]; then
    echo "  skip $(basename "$dest") (exists)"
    return
  fi
  echo "  get  $(basename "$dest")"
  curl -fsSL --retry 3 --max-time 300 "$url" -o "$dest"
}

echo "Pagila -> fixtures/postgres"
fetch "$PAGILA_RAW/pagila-schema.sql" "$FIXTURES/postgres/01-pagila-schema.sql"
fetch "$PAGILA_RAW/pagila-data.sql"   "$FIXTURES/postgres/02-pagila-data.sql"

echo "Sakila -> fixtures/mysql"
if [[ -s "$FIXTURES/mysql/01-sakila-schema.sql" && -s "$FIXTURES/mysql/02-sakila-data.sql" ]]; then
  echo "  skip sakila (exists)"
else
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "  get  sakila-db.tar.gz"
  curl -fsSL --retry 3 --max-time 300 "$SAKILA_TGZ" -o "$tmp/sakila.tar.gz"
  tar -xzf "$tmp/sakila.tar.gz" -C "$tmp"
  cp "$tmp/sakila-db/sakila-schema.sql" "$FIXTURES/mysql/01-sakila-schema.sql"
  cp "$tmp/sakila-db/sakila-data.sql"   "$FIXTURES/mysql/02-sakila-data.sql"
fi

echo
echo "Done. Sizes:"
du -h "$FIXTURES"/*/*.sql | sed 's/^/  /'
echo
echo "Next: npm run db:up"
