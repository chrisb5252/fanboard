#!/usr/bin/env bash
#
# FanBoard database backup.
#
#   DATABASE_URL=postgresql://... ./packages/backend/scripts/backup.sh [outdir]
#
# Run it before going live, before any schema change, and after a busy night.
#
# Two things this does that a bare `pg_dump > file` does not, both learned the
# hard way by people who found out during a restore:
#
#  1. It fails loudly. `pg_dump > file` with a bad URL leaves a zero-byte file
#     and exit status 0 from the shell's point of view, so the backup looks like
#     it worked until the night you need it.
#  2. It verifies the dump afterwards — non-empty, ends with pg_dump's own
#     completion marker, and contains the tables that matter. An unverified
#     backup is a hypothesis.

set -Eeuo pipefail

OUTDIR="${1:-.}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUTFILE="${OUTDIR}/fanboard-${STAMP}.sql"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set." >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "pg_dump not found. Install the postgresql client tools." >&2
  exit 1
fi

mkdir -p "${OUTDIR}"

echo "backing up to ${OUTFILE}"

# --no-owner / --no-privileges: a restore usually lands in a database owned by a
# different role than production, and ownership statements make it fail on
# permissions rather than on anything that matters.
pg_dump "${DATABASE_URL}" \
  --no-owner \
  --no-privileges \
  --format=plain \
  --file="${OUTFILE}"

# --- verification -----------------------------------------------------------

if [ ! -s "${OUTFILE}" ]; then
  echo "FAILED: dump is empty" >&2
  exit 1
fi

if ! tail -5 "${OUTFILE}" | grep -q "PostgreSQL database dump complete"; then
  echo "FAILED: dump has no completion marker — it was truncated" >&2
  exit 1
fi

missing=""
for table in venues games picks player_sessions leaderboard_snapshot audit_logs devices; do
  if ! grep -q "CREATE TABLE public.${table}\|COPY public.${table}" "${OUTFILE}"; then
    missing="${missing} ${table}"
  fi
done

if [ -n "${missing}" ]; then
  echo "FAILED: dump is missing tables:${missing}" >&2
  exit 1
fi

SIZE="$(wc -c < "${OUTFILE}" | tr -d ' ')"
ROWS="$(grep -c '^COPY public\.' "${OUTFILE}" || true)"

echo "ok: ${OUTFILE}"
echo "    ${SIZE} bytes, ${ROWS} table(s) with data, all expected tables present"
echo
echo "restore with:"
echo "    psql \"\$DATABASE_URL\" < ${OUTFILE}"
echo
echo "Restore into a scratch database and run the integrity checks in"
echo "RUNBOOKS.md before trusting this file."
