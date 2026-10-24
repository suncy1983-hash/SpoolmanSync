# SpoolmanSync Home Assistant Add-on (suncy1983-hash fork, auto-create spools)
#
# Built locally by the Home Assistant Supervisor, whose build context is this
# add-on folder only. The Next.js app source (../app) is therefore fetched from
# the fork's release branch matching the add-on version (addon-v<version>),
# which also busts the Docker build cache on every version bump.

ARG BUILD_FROM
ARG BUILD_VERSION

FROM node:20-alpine AS base

# Fetch the app source for this exact version
FROM alpine:3.20 AS source
ARG BUILD_VERSION
RUN apk add --no-cache curl tar
WORKDIR /src
RUN curl -fsSL "https://github.com/suncy1983-hash/SpoolmanSync/archive/refs/heads/addon-v${BUILD_VERSION}.tar.gz" \
    | tar xz --strip-components=1

# Install dependencies only when needed
FROM base AS deps
# Add build tools for native modules (better-sqlite3)
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

COPY --from=source /src/app/package.json /src/app/package-lock.json ./
RUN npm ci

# Build stage
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=source /src/app/ .

ENV DATABASE_URL="file:./placeholder.db"
ENV ADDON_BUILD=true
RUN npx prisma generate
RUN npm run build

# Production image
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HA_MODE=addon

# Install runtime dependencies
RUN apk add --no-cache libc6-compat nginx bash jq curl

RUN mkdir -p /data

# Copy standalone build
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Copy Prisma schema and config for migrations
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/src/generated ./src/generated

# Copy all node_modules from deps
COPY --from=deps /app/node_modules ./node_modules

# Copy nginx config and run script (relative to this add-on folder)
COPY rootfs/etc/nginx/http.d/default.conf /etc/nginx/http.d/default.conf
COPY rootfs/run.sh /run.sh
RUN chmod a+x /run.sh

EXPOSE 3000 8099

ENV HOSTNAME="127.0.0.1"
ENV DATABASE_URL="file:/data/spoolmansync.db"

CMD ["/run.sh"]
