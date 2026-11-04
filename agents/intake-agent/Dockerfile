# Intake Agent image.
#
# IMPORTANT: build from the REPO ROOT, not this directory, because the agent is
# a workspace package that depends on @vera/schemas and resolves through the
# root package-lock.json:
#
#   docker build -f agents/intake-agent/Dockerfile -t vera-intake-agent .
#
# Pinned, minimal, non-root — matches the design's build/runtime conventions.

FROM node:22-slim AS build
WORKDIR /app

# Manifests first, for layer caching. Copy every workspace package.json the
# root lockfile references so `npm ci` can install the whole workspace.
COPY package.json package-lock.json ./
COPY tsconfig.base.json tsconfig.json ./
COPY schemas/package.json ./schemas/
COPY agents/drafting/package.json ./agents/drafting/
COPY agents/history-check/package.json ./agents/history-check/
COPY agents/intake-agent/package.json ./agents/intake-agent/
RUN npm ci

# Sources needed to build @vera/schemas and the intake agent (project refs).
COPY schemas ./schemas
COPY agents/intake-agent ./agents/intake-agent
RUN npm run build --workspace @vera/agent-intake

# ---- Runtime stage: prod-only deps, compiled output ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY schemas/package.json ./schemas/
COPY agents/intake-agent/package.json ./agents/intake-agent/
RUN npm ci --omit=dev

# Built JS for both the agent and its @vera/schemas dependency.
COPY --from=build /app/schemas/dist ./schemas/dist
COPY --from=build /app/agents/intake-agent/dist ./agents/intake-agent/dist

USER node
EXPOSE 8081
CMD ["node", "agents/intake-agent/dist/server.js"]
