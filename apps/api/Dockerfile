# syntax=docker/dockerfile:1
# Build from the REPO ROOT:  docker build -f apps/api/Dockerfile --build-arg GIT_SHA=$(git rev-parse HEAD) -t ghcr.io/omeieee/pos-api:<sha> .
# Run migrations:            docker run --rm --env-file .env <image> node dist/migrate.js

# Runs on the builder's own architecture: the bundle is plain JS, so an arm64 image needs no emulation here.
FROM --platform=$BUILDPLATFORM node:24-slim AS build
WORKDIR /repo
# pnpm version pinned to package.json "packageManager".
RUN npm install -g pnpm@12.6.0
COPY . .
RUN pnpm install --frozen-lockfile --filter @sds/api...
RUN pnpm --filter @sds/api build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Tesseract reads the amount on transfer slips (D-26), on this machine only: a slip shows a name and
# an account number, so it never goes to a cloud service. Thai for the labels, English for digits.
# Adds roughly 70-100 MB to the image and about 200 MB of memory while one slip is being read.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-tha tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/*
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
# Default heap cap for the 1 GB VM. The compose file overrides it per VM (API_NODE_OPTIONS in .env).
ENV NODE_OPTIONS=--max-old-space-size=384
CMD ["node", "dist/server.js"]
