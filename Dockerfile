# Rawuser on your own server: the two workers and the dashboard in one
# process, over SQLite files in /data. See docs/self-hosting.md.
FROM node:22-slim

WORKDIR /app
RUN corepack enable

# Dependencies first, so a change to the code does not install them again.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/snippet/package.json packages/snippet/
COPY packages/signals/package.json packages/signals/
COPY packages/intent/package.json packages/intent/
COPY packages/edge/package.json packages/edge/
COPY packages/generation/package.json packages/generation/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile

COPY . .

ENV DATA_DIR=/data \
    HOST=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
VOLUME /data
EXPOSE 8787 8788 8789

# The dashboard names its API by address, so it is built on the first start
# for the addresses in your settings, and again only when they change.
CMD ["pnpm", "server:start"]
