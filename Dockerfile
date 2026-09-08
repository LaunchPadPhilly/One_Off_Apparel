# syntax=docker/dockerfile:1

# Production image for the SvelteKit app (adapter-node), deployed to AWS ECS
# Fargate. RDS is external; ECS injects DATABASE_URL and other runtime secrets
# from AWS Secrets Manager when the task starts.

ARG NODE_VERSION=24-slim

# ---------------------------------------------------------------------------
# deps: install the full dependency tree (incl. devDependencies) once, and
# let Docker cache it across builds unless package.json/pnpm-lock.yaml change.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
	pnpm install --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------------------
# build: generate the Prisma client and compile the SvelteKit production
# bundle. DATABASE_URL here is a placeholder — prisma.config.ts only needs
# it to be present to validate config, `prisma generate` never connects to
# it. The real DATABASE_URL is a runtime secret, injected at container start.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
# Selects adapter-node instead of adapter-auto for both AWS environments.
ENV BUILD_TARGET=docker
# `deps` installs with --ignore-scripts, so postinstall (svelte-kit sync &&
# prisma generate) never ran — tsconfig.json extends ./.svelte-kit/tsconfig.json,
# which only exists after `svelte-kit sync`. Without this, `prisma generate`
# fails resolving that tsconfig chain before it ever reaches the schema.
RUN pnpm run prepare
RUN pnpm run db:generate
RUN pnpm run build

# ---------------------------------------------------------------------------
# runtime: production-only dependencies plus the compiled app. No build
# tools, no devDependencies, no source beyond what `prisma migrate deploy`
# needs (schema + migrations + config).
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
RUN corepack enable && groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs sveltekit
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
	pnpm install --prod --frozen-lockfile --ignore-scripts

COPY --from=build /app/build ./build
# Not copying prisma/generated: the SvelteKit build fully bundles the
# generated Prisma client into build/server/chunks/*.js (verified by
# inspecting build output — no external reference to prisma/generated and
# no .wasm assets). `prisma migrate deploy` below doesn't need the generated
# client either, only schema.prisma + migrations.
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY prisma/migrations ./prisma/migrations
COPY prisma.config.ts ./prisma.config.ts

# node_modules and the copied files above are owned by root (installed/copied
# before this point); `prisma migrate deploy` runs as `sveltekit` in the
# one-off `migrate` service and needs write access under node_modules to
# prepare its query engine binary.
RUN chown -R sveltekit:nodejs /app

USER sveltekit
EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0

CMD ["node", "build"]
