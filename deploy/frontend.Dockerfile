# Builds all three Vite frontends into one image and serves whichever the APP
# environment variable names.
#
#   docker build -f deploy/frontend.Dockerfile -t fanboard-frontend .
#   docker run -e APP=mobile-web -e BACKEND_ORIGIN=... -p 8080:8080 fanboard-frontend
#
# APP is one of: mobile-web | fire-tv | admin-web
#
# Why one image rather than a Dockerfile per app, or a PACKAGE build argument:
#
#  - Three Dockerfiles would each carry a full copy of this build. Docker has no
#    include mechanism, so "thin" per-app files are not a thing that exists —
#    they would be three copies that drift, and the one that drifts is always
#    the one nobody is looking at.
#  - A build argument works locally but depends on the platform forwarding
#    variables into the build, which not every platform does. Selecting at run
#    time removes that question: the same image is deployed three times with a
#    different APP, which is also what makes "is the bug in the build or the
#    config" answerable.
#
# The cost, stated plainly: every frontend service builds all three apps, so a
# type error in admin-web fails the patron app's deploy too. That coupling is
# real. It is acceptable here because `npm run build` already type-checks all
# three together in CI, so a broken app is caught before any deploy — and the
# few hundred KB of bundles a service does not serve is not worth three
# diverging Dockerfiles.
#
# Build from the REPO ROOT: npm workspaces keeps the lockfile there and `npm ci`
# will not run without it.

FROM node:22-alpine AS builder

WORKDIR /app

# Manifests first, so the install layer is keyed on the lockfile rather than on
# application code.
COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
COPY packages/admin-web/package.json packages/admin-web/
COPY packages/mobile-web/package.json packages/mobile-web/
COPY packages/fire-tv/package.json packages/fire-tv/
RUN npm ci

COPY tsconfig.json ./
COPY packages/mobile-web ./packages/mobile-web
COPY packages/fire-tv ./packages/fire-tv
COPY packages/admin-web ./packages/admin-web

# Each package's `build` runs `tsc --noEmit` before `vite build`, so a type
# error fails the image rather than shipping.
RUN npm run build --workspace @fanboard/mobile-web \
 && npm run build --workspace @fanboard/fire-tv \
 && npm run build --workspace @fanboard/admin-web

# -----------------------------------------------------------------------------

FROM caddy:2-alpine AS runner

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY deploy/frontend-entrypoint.sh /usr/local/bin/frontend-entrypoint.sh

COPY --from=builder /app/packages/mobile-web/dist /srv/mobile-web
COPY --from=builder /app/packages/fire-tv/dist   /srv/fire-tv
COPY --from=builder /app/packages/admin-web/dist /srv/admin-web

# Source maps are useful for reading a minified stack trace and they also hand
# the reader the original source. Drop them from the image; upload them to an
# error tracker instead if you want symbolication.
RUN rm -f /srv/*/assets/*.map \
 && chmod +x /usr/local/bin/frontend-entrypoint.sh

# BACKEND_ORIGIN must be set at runtime — on Railway, the backend's private
# address, e.g. http://backend.railway.internal:3000. Deliberately no default: a
# wrong guess would proxy to nowhere and look like an application bug.
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/frontend-entrypoint.sh"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
