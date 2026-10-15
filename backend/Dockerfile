# syntax=docker/dockerfile:1
#
# Backend image for EDAMS. This is an npm workspaces monorepo (see the root
# package.json — "workspaces": ["backend", "frontend"]), so this Dockerfile's
# build context must be the REPO ROOT, not this backend/ folder, or `npm ci`
# won't see the workspace lockfile/hoisted deps that CI and local dev both
# rely on. Build it from the repo root:
#
#   docker build -f backend/Dockerfile -t edams-backend .
#
# (docker-compose.yml at the repo root is already wired up this way.)

# ---- deps: install the full workspace (both workspaces' package.json + the
#      root lockfile), so installed versions match exactly what CI installs ----
FROM node:22-bookworm-slim AS deps
WORKDIR /repo
# `canvas` (node-canvas/Cairo — used for OCR PDF rasterization, swapped in
# 2026-08-28 off @napi-rs/canvas, whose native renderer segfaults on certain
# CMYK-gradient PDFs) links against Cairo/Pango/JPEG/GIF/RSVG at build time.
# A Linux x64 glibc prebuilt binary is usually available so this rarely
# actually compiles from source, but build-essential + the -dev headers are
# kept here so `npm ci` still succeeds by compiling from source on any
# platform/Node-ABI combo without a published prebuild.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config python3 \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci

# ---- build: compile backend TypeScript (tsc, per backend/tsconfig.json) ----
FROM deps AS build
COPY tsconfig.base.json ./tsconfig.base.json
COPY backend ./backend
RUN npm run build --workspace backend

# ---- prune: drop devDependencies from the installed tree (npm prune
#      correctly respects workspaces, unlike trying to `ci --omit=dev` a
#      single workspace out of a monorepo from scratch) ----
FROM deps AS prune
RUN npm prune --omit=dev

# ---- runtime: slim image, only what's needed to run the compiled backend ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo

# Runtime shared libraries `canvas` dynamically links against (no -dev
# headers needed here, unlike the deps/build stages — this is the shared
# .so's only). Missing this makes `require('canvas')` throw
# "libcairo.so.2: cannot open shared object file" at OCR-job time — a
# container-only failure mode that would never show up in local dev.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 libpixman-1-0 \
    && rm -rf /var/lib/apt/lists/*

# Hoisted (shared) deps + the small set of backend-specific ones npm couldn't hoist.
COPY --from=prune /repo/node_modules ./node_modules
COPY --from=prune /repo/backend/node_modules ./backend/node_modules
COPY --from=build /repo/backend/dist ./backend/dist
COPY backend/migrations ./backend/migrations
# Runtime assets read from disk (letter PDF Unicode fonts — letterPdf.ts
# resolves assets/fonts relative to the backend working directory).
COPY backend/assets ./backend/assets
COPY backend/package.json ./backend/package.json
COPY package.json ./package.json

WORKDIR /repo/backend
EXPOSE 7100
USER node

# Same command whether this runs as the API (ENABLE_QUEUE_WORKERS=false) or
# the worker (ENABLE_QUEUE_WORKERS=true, command overridden to
# "node dist/src/bin/worker.js" — see docker-compose.yml's `worker` service).
CMD ["node", "dist/src/main.js"]
