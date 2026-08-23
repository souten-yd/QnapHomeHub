FROM node:24-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ libbluetooth-dev libudev-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json server/tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY server/src ./src
COPY server/test ./test
COPY server/public ./public
RUN npm run typecheck && npm test && npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bluetooth bluez libbluetooth3 libudev1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist
COPY server/public ./public
ENV PORT=8787 DATA_DIR=/data NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8787
CMD ["node","dist/index.js"]
