# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: install all deps and compile core, server, mcp, and the UI.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
# Pin pnpm explicitly (root package.json has no packageManager field, so
# corepack's default could drift from the version that wrote the lockfile).
RUN npm install -g pnpm@10.27.0
WORKDIR /app

# Manifests first so the dependency layer caches across source-only changes.
# Every workspace package's manifest must be present or --frozen-lockfile
# rejects the lockfile (importer set mismatch).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/ui/package.json apps/ui/
COPY apps/mcp/package.json apps/mcp/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ---------------------------------------------------------------------------
# Runtime stage: official Playwright image ships Chromium + all system deps
# (PLAYWRIGHT_BROWSERS_PATH is preset). Tag matches the pinned playwright
# 1.60.0 in pnpm-lock.yaml so browser revisions line up.
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.60.0-noble
RUN npm install -g pnpm@10.27.0
WORKDIR /app
ENV NODE_ENV=production

# Fresh production install in THIS stage so native modules (better-sqlite3)
# are built/downloaded for this image's Node ABI — never copied across from
# the build stage, whose Node version may differ. pnpm's onlyBuiltDependencies
# (root package.json) allows better-sqlite3's build script to run.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/ui/package.json apps/ui/
COPY apps/mcp/package.json apps/mcp/
RUN pnpm install --frozen-lockfile --prod

# Built artifacts only — no sources, no dev dependencies. The server resolves
# the UI at ../ui/dist relative to its own package dir (apps/server/src/app.ts).
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/ui/dist apps/ui/dist
COPY --from=build /app/apps/mcp/dist apps/mcp/dist

ENV SORTIE_HOST=0.0.0.0 \
    SORTIE_PORT=3470 \
    SORTIE_DATA_DIR=/data

# Run as the Playwright image's built-in non-root user (pwuser, UID 1000)
# instead of root. The data dir and app tree are handed to it so the server
# can persist without elevated privileges. NOTE: a host bind-mount at /data
# must also be owned by UID 1000, or chown'd to it, for writes to succeed.
RUN mkdir -p /data && chown -R pwuser:pwuser /app /data
USER pwuser

VOLUME /data
EXPOSE 3470
CMD ["node", "apps/server/dist/index.js"]
