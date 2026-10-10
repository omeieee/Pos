# syntax=docker/dockerfile:1
# Build from the REPO ROOT:  docker build -f apps/api/Dockerfile --build-arg GIT_SHA=$(git rev-parse HEAD) -t ghcr.io/omeieee/pos-api:<sha> .
# Run migrations:            docker run --rm --env-file .env <image> node dist/migrate.js

FROM node:24-slim AS build
WORKDIR /repo
# pnpm version pinned to package.json "packageManager".
RUN npm install -g pnpm@12.6.0
COPY . .
RUN pnpm install --frozen-lockfile --filter @sds/api...
RUN pnpm --filter @sds/api build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# The bundle inlines every dependency, so dist/ (server.js, migrate.js, migrations/) is all we need.
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
ARG GIT_SHA=dev
ENV GIT_SHA=${GIT_SHA}
# Slip images (SLIP_DIR). A named volume mounted here starts with this owner, so `node` can write.
RUN mkdir -p /data/slips && chown node:node /data/slips
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--max-old-space-size=384", "dist/server.js"]
