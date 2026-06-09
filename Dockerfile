# Build stage
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/ui/package.json apps/ui/ 2>/dev/null || true
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Runtime stage: official Playwright image ships Chromium + all system deps
FROM mcr.microsoft.com/playwright:v1.60.0-noble
RUN corepack enable
WORKDIR /app
COPY --from=build /app /app
RUN pnpm install --frozen-lockfile --prod
ENV NANOFISH_HOST=0.0.0.0 \
    NANOFISH_PORT=3470 \
    NANOFISH_DATA_DIR=/data
VOLUME /data
EXPOSE 3470
CMD ["node", "apps/server/dist/index.js"]
