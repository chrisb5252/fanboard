# Builds any one of the three Vite frontends and serves it with Caddy.
#
# Build from the REPO ROOT, naming the workspace:
#
#   docker build -f deploy/frontend.Dockerfile \
#     --build-arg PACKAGE=mobile-web -t fanboard-mobile .
#
# One file for all three because they differ only in which workspace is built.
# Three near-identical Dockerfiles would drift, and the one that drifts is
# always the one nobody is looking at.
#
# Root context: npm workspaces keeps the lockfile at the repo root and `npm ci`
# will not run without it.

ARG PACKAGE

FROM node:22-alpine AS builder
ARG PACKAGE

WORKDIR /app

# Manifests first so the install layer is keyed on the lockfile rather than on
# application code.
COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
COPY packages/admin-web/package.json packages/admin-web/
COPY packages/mobile-web/package.json packages/mobile-web/
COPY packages/fire-tv/package.json packages/fire-tv/
RUN npm ci

COPY tsconfig.json ./
COPY packages/${PACKAGE} ./packages/${PACKAGE}

# `build` runs tsc --noEmit before vite build, so a type error fails the image
# rather than shipping.
RUN npm run build --workspace @fanboard/${PACKAGE}

# -----------------------------------------------------------------------------

FROM caddy:2-alpine AS runner
ARG PACKAGE

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /app/packages/${PACKAGE}/dist /srv

# Source maps are emitted by the build and are useful for debugging a minified
# stack trace, but they hand the reader the original source. Drop them; upload
# them to an error tracker instead if you want symbolication.
RUN rm -f /srv/assets/*.map

# BACKEND_ORIGIN must be set at runtime — on Railway, the backend's private
# address, e.g. http://backend.railway.internal:3000. There is deliberately no
# default: a wrong guess would silently proxy to nowhere and look like an
# application bug.
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || exit 1

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
