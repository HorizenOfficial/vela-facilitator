# ---- Build stage ----
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/x402-private-vela-fixed/package.json packages/x402-private-vela-fixed/
COPY packages/contracts/package.json packages/contracts/

RUN pnpm install --frozen-lockfile

# Copy source files (workspace package + root)
COPY packages/x402-private-vela-fixed/ packages/x402-private-vela-fixed/
COPY tsconfig.json ./
COPY src/ src/

# Build workspace package first, then root
RUN pnpm --filter @horizen/x402-private-vela-fixed build && pnpm build

# ---- Runtime stage ----
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/x402-private-vela-fixed/package.json packages/x402-private-vela-fixed/
COPY packages/contracts/package.json packages/contracts/

RUN pnpm install --frozen-lockfile --prod

# Copy compiled output from build stage
COPY --from=build /app/dist/ dist/
COPY --from=build /app/packages/x402-private-vela-fixed/dist/ packages/x402-private-vela-fixed/dist/

ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
