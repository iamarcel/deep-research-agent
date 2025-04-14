FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- Dependencies Stage ---
FROM base AS deps
COPY pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

# --- Build Stage ---
FROM deps AS build
WORKDIR /app

COPY --from=deps /app/*  .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . /app

RUN pnpm run build

# --- Final Application Stage ---
FROM build AS app
WORKDIR /app

COPY --from=deps /app/*  .
COPY --from=build /app/.output ./.output

ENV PORT=${PORT:-8000}
EXPOSE ${PORT}
CMD [ "node", "./.output/a2a-server.js" ]