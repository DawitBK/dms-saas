# syntax=docker/dockerfile:1
#
# Frontend image for EDAMS. Same monorepo caveat as backend/Dockerfile: build
# from the REPO ROOT so npm workspaces resolve correctly:
#
#   docker build -f frontend/Dockerfile -t edams-frontend .
#
# next.config.ts already sets `output: 'standalone'`, which is exactly the
# "minimal self-contained server + only the deps actually used" shape this
# Dockerfile is built around — don't remove that config option, this
# Dockerfile depends on it.

FROM node:22-bookworm-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci

FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json ./tsconfig.base.json
COPY frontend ./frontend
# Public env vars are baked in at build time by Next.js — pass the real
# per-environment values as --build-arg when building for staging/production,
# not just at container-run time (NEXT_PUBLIC_* vars are inlined into the
# client bundle during `next build`, unlike server-only env vars).
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_SOCKET_URL
ARG NEXT_PUBLIC_BASE_PATH
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV NEXT_PUBLIC_SOCKET_URL=${NEXT_PUBLIC_SOCKET_URL}
ENV NEXT_PUBLIC_BASE_PATH=${NEXT_PUBLIC_BASE_PATH}
RUN npm run build --workspace frontend

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# `standalone` already bundles just the node_modules this app actually needs —
# static assets and public/ are excluded from it on purpose (Next.js expects
# you to copy them alongside), so all three copies below are required.
COPY --from=build /repo/frontend/.next/standalone ./
COPY --from=build /repo/frontend/.next/static ./frontend/.next/static
COPY --from=build /repo/frontend/public ./frontend/public

WORKDIR /app/frontend
ENV PORT=7101
EXPOSE 7101
USER node
CMD ["node", "server.js"]
