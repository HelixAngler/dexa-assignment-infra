#!/usr/bin/env bash
#
# Applies both database schemas (main domain DB and log DB) to their
# PostgreSQL instances. Idempotent: `prisma migrate deploy` records every
# applied migration, so rerunning this script only applies what is missing.
#
# Required environment:
#   DATABASE_URL_MAIN  e.g. postgres://user:pass@host:5432/wfh_main
#   DATABASE_URL_LOG   e.g. postgres://user:pass@host:5433/wfh_log
# Variables already exported by the caller win; otherwise they are read from
# the .env file next to this script's parent directory when that file exists.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -f "${INFRA_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${INFRA_DIR}/.env"
  set +a
fi

missing=()
[[ -n "${DATABASE_URL_MAIN:-}" ]] || missing+=("DATABASE_URL_MAIN")
[[ -n "${DATABASE_URL_LOG:-}" ]] || missing+=("DATABASE_URL_LOG")

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "migrate.sh: missing required environment variable(s): ${missing[*]}" >&2
  echo "migrate.sh: export them in the current shell, or define them in the .env file of $(basename "${INFRA_DIR}")" >&2
  exit 1
fi

cd "${INFRA_DIR}"

echo "migrate.sh: deploying main schema migrations"
npx prisma migrate deploy --schema prisma/main/schema.prisma

echo "migrate.sh: deploying log schema migrations"
npx prisma migrate deploy --schema prisma/log/schema.prisma

echo "migrate.sh: both schemas are up to date"
