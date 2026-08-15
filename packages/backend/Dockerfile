# FanBoard backend — API and job host.
#
# Build from the REPO ROOT, not from this directory:
#
#   docker build -f packages/backend/Dockerfile -t fanboard-backend .
#
# This is an npm workspaces monorepo. The lockfile lives at the root, and
# `npm ci` refuses to run without it, so the root has to be the build context.
# A context of ./packages/backend cannot see package-lock.json and the install
# fails before it starts.
#
# Multi-stage for the same reason: the build needs TypeScript, the Next
# compiler and the type packages, all of which are devDependencies. Installing
# with --omit=dev and then running `npm run build` fails — the compiler is not
# there. So the build stage installs everything, and the runtime stage gets a
# separate production-only install with none of it.

# Node 22: the root package.json declares engines.node >=22, and building on a
# runtime older than the one the project claims to support hides incompatibilities
# until deploy.
FROM node:22-alpine AS deps

WORKDIR /app

# Manifests only, before any source. This layer is keyed on the lockfile, so
# editing application code does not re-run a full install.
COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
COPY packages/admin-web/package.json packages/admin-web/
COPY packages/mobile-web/package.json packages/mobile-web/
COPY packages/fire-tv/package.json packages/fire-tv/

# The whole workspace tree, dev dependencies included — the build needs them.
RUN npm ci

# -----------------------------------------------------------------------------

FROM node:22-alpine AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY packages/backend ./packages/backend

# next build reads .env.local if present. .dockerignore excludes it, so the
# build cannot accidentally bake a developer's local database URL into the
# image. Runtime configuration arrives as environment variables.
RUN npm run build --workspace @fanboard/backend

# -----------------------------------------------------------------------------

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
# Next installs its own SIGTERM handler before the app loads and exits straight
# from it, which would kill the process mid-drain. This hands the signal to the
# worker scheduler's shutdown path instead. Without it, a deploy can interrupt
# a grading transaction.
ENV NEXT_MANUAL_SIG_HANDLE=true

# A production-only install: no TypeScript, no vitest, no type packages.
COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
COPY packages/admin-web/package.json packages/admin-web/
COPY packages/mobile-web/package.json packages/mobile-web/
COPY packages/fire-tv/package.json packages/fire-tv/
RUN npm ci --omit=dev --workspace @fanboard/backend --include-workspace-root

COPY --from=builder /app/packages/backend/.next ./packages/backend/.next
COPY --from=builder /app/packages/backend/next.config.ts ./packages/backend/
COPY packages/backend/schema.sql ./packages/backend/

# Run unprivileged. The node image ships a `node` user for exactly this; a
# container process that does not need root should not have it.
RUN chown -R node:node /app
USER node

# 3000 is the API's default. `npm start` runs a bare `next start`, which binds
# $PORT when the platform sets one (Railway, Cloud Run, Heroku all do) and
# falls back to 3000 otherwise — verified both ways.
#
# 3100 is the WebSocket listener, in this same process on its own port because
# Next's App Router does not expose its HTTP server for an upgrade handler.
# NOTE: a platform that publishes only ONE port per service cannot reach it.
# See DEPLOYMENT.md.
EXPOSE 3000
EXPOSE 3100

# The platform health check hits the same endpoint the runbooks use. It reads
# PORT rather than assuming 3000, so setting PORT does not silently break the
# check and get a healthy container restarted. Start period allows for the
# first database connection and the worker boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/packages/backend
CMD ["npm", "start"]
