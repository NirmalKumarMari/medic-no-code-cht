# Pinned, minimal, non-root — matches the design doc's build/runtime conventions.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8081
CMD ["node", "dist/server.js"]
