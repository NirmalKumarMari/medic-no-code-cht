# Build from the repository root, not the agent folder.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig*.json ./
COPY packages ./packages
COPY schemas ./schemas
COPY agents ./agents
RUN npm ci --ignore-scripts && npm run build && npm run test:agents \
    && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8083
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/schemas ./schemas
COPY --from=build --chown=node:node /app/agents/change-planner-agent ./agents/change-planner-agent
COPY --from=build --chown=node:node /app/package.json ./
USER node
EXPOSE 8083
CMD ["node", "agents/change-planner-agent/dist/server.js"]
