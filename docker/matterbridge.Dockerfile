FROM node:24-bookworm AS build
WORKDIR /app/plugin
COPY matterbridge-plugin/package.json matterbridge-plugin/tsconfig.json ./
RUN npm install --install-strategy=nested --no-audit --no-fund
COPY matterbridge-plugin/src ./src
RUN npm run typecheck && npm run build

FROM node:24-bookworm-slim
WORKDIR /app/plugin
COPY matterbridge-plugin/package.json matterbridge-plugin/matterbridge-qnaphomehub.config.json ./
# Matterbridge derives its application root from the location of @matterbridge/core.
# Keep dependencies nested so npm hoisting does not make Matterbridge look for
# apps/frontend under /app/plugin instead of node_modules/matterbridge.
RUN npm install --omit=dev --install-strategy=nested --no-audit --no-fund
COPY --from=build /app/plugin/dist ./dist
COPY docker/matterbridge-bootstrap.mjs /app/plugin/matterbridge-bootstrap.mjs
COPY docker/matterbridge-entrypoint.sh /usr/local/bin/matterbridge-entrypoint
RUN chmod +x /usr/local/bin/matterbridge-entrypoint
ENV QNAP_HOME_HUB_URL=http://127.0.0.1:8787 MATTERBRIDGE_HOMEDIR=/data
VOLUME ["/data"]
EXPOSE 8283 5540
ENTRYPOINT ["matterbridge-entrypoint"]
