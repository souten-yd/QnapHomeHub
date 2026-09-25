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
ARG HOMEHUB_VERSION=0.1.0
RUN apt-get update && apt-get install -y --no-install-recommends bluetooth bluez libbluetooth3 libudev1 dbus python3 python3-venv && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/ble && /opt/ble/bin/pip install --no-cache-dir bleak==0.22.3
WORKDIR /app
COPY server/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist
COPY server/public ./public
COPY server/ble ./ble
COPY docker/server-entrypoint.sh /usr/local/bin/homehub-entrypoint
RUN chmod 755 /usr/local/bin/homehub-entrypoint
ENTRYPOINT ["/usr/local/bin/homehub-entrypoint"]
ENV PORT=8787 DATA_DIR=/data NODE_ENV=production HOMEHUB_VERSION=${HOMEHUB_VERSION}
LABEL org.opencontainers.image.version=${HOMEHUB_VERSION}
VOLUME ["/data"]
EXPOSE 8787
CMD ["node","dist/index.js"]
