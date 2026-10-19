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
# frontend/package.json depends on "xlsx": "file:../vendor/xlsx-0.20.3.tgz"; npm ci cannot resolve it without the tarball
COPY vendor ./vendor
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
# `npm run build` ends with a postbuild step (scripts/build-fingerprint.cjs) that
# hashes frontend/.env.production and stamps it into .next, and fails when the
# file is missing. It is gitignored, so a clean checkout (CI) has none. Write one
# from the build args only when the build context did not bring a real one; the
# ENV values above already take precedence inside `next build` either way.
RUN [ -f frontend/.env.production ] || printf 'NEXT_PUBLIC_API_BASE_URL=%s\nNEXT_PUBLIC_SOCKET_URL=%s\nNEXT_PUBLIC_BASE_PATH=%s\n' "$NEXT_PUBLIC_API_BASE_URL" "$NEXT_PUBLIC_SOCKET_URL" "$NEXT_PUBLIC_BASE_PATH" > frontend/.env.production
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
