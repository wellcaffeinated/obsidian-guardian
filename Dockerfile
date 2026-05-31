# Obsidian Guardian — CLI / container adapter.
# Builds the pnpm workspace and runs the CLI (default: `watch`) over a mounted
# vault. The engine is pure isomorphic-git, so no native git is needed.
FROM node:22-slim

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# corepack for pnpm; gosu to drop to the host user (PUID/PGID) at runtime.
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (cached unless a manifest or the lockfile changes).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile

# Build the engine then the CLI (pnpm resolves the topological order).
COPY . .
RUN pnpm build

# The vault (work-tree) and the git database are provided as mounts at runtime.
ENV OG_VAULT=/vault
ENV OG_GIT_DIR=/gitdir

# `og` is a short CLI shim on PATH (for `docker compose exec guardian og …`);
# the entrypoint chowns the gitDir then hands off to it.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY docker-og.sh /usr/local/bin/og
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/og

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["watch", "--poll"]
