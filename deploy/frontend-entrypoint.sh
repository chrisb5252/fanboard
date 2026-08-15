#!/bin/sh
set -e

# Validates configuration before Caddy starts.
#
# Both checks exist because their failure modes are quiet. An unset or misspelt
# APP leaves Caddy rooted at a directory with no index.html, so every request
# 404s and the natural conclusion is that the build produced nothing. A missing
# BACKEND_ORIGIN starts a server that serves the app perfectly and fails every
# API call, which reads as a backend outage.
#
# Failing at startup with the reason costs one line in the deploy log. Failing
# later costs an afternoon.

if [ -z "${APP}" ]; then
  echo "APP is not set. Expected one of: mobile-web, fire-tv, admin-web." >&2
  exit 1
fi

if [ ! -f "/srv/${APP}/index.html" ]; then
  echo "APP=${APP} does not name a built app. Available:" >&2
  ls -1 /srv >&2
  exit 1
fi

if [ -z "${BACKEND_ORIGIN}" ]; then
  echo "BACKEND_ORIGIN is not set. Expected the backend's address," >&2
  echo "e.g. http://backend.railway.internal:3000" >&2
  exit 1
fi

echo "serving ${APP}, proxying /api and /ws to ${BACKEND_ORIGIN}"

exec "$@"
