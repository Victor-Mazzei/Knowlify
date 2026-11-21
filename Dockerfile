ARG VERSION=dev
ARG GIT_SHA=dev
ARG BUILD_DATE=

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps apps
RUN npm run build -w @knowlify/server && npm run build -w @knowlify/web

FROM node:22-bookworm-slim

# Build metadata is injected by the CI image build (and optionally by docker compose).
# The server reads its version from apps/server/package.json; these two values are
# only the commit/date shown by GET /api/about.
ARG VERSION
ARG GIT_SHA
ARG BUILD_DATE
ARG SOURCE_URL=
LABEL org.opencontainers.image.title="Knowlify" \
      org.opencontainers.image.description="Local-first ebook library with web reader, notes, OPDS/KOSync and an optional LLM tutor" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source="https://github.com/Victor-Mazzei/Knowlify"

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    KNOWLIFY_DATA=/data \
    KNOWLIFY_MODELS_DIR=/data/models \
    KNOWLIFY_WEB_DIR=/app/web \
    KNOWLIFY_BUILD_COMMIT="${GIT_SHA}" \
    KNOWLIFY_BUILD_DATE="${BUILD_DATE}" \
    KNOWLIFY_SOURCE_URL="${SOURCE_URL}"
COPY package.json package-lock.json ./
# The server resolves ../package.json at runtime; keep the workspace manifest next to dist.
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev --include=optional -w @knowlify/server && npm cache clean --force
RUN mkdir -p /data/models
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist web
COPY LICENSE /app/
VOLUME /data
EXPOSE 8787
HEALTHCHECK CMD node -e "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
