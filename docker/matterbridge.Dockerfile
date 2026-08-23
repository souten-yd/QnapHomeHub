FROM node:24-bookworm AS build
WORKDIR /app/plugin
COPY matterbridge-plugin/package.json matterbridge-plugin/tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY matterbridge-plugin/src ./src
RUN npm run typecheck && npm run build

FROM node:24-bookworm-slim
WORKDIR /app/plugin
COPY matterbridge-plugin/package.json matterbridge-plugin/matterbridge-qnaphomehub.config.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/plugin/dist ./dist
COPY docker/matterbridge-entrypoint.sh /usr/local/bin/matterbridge-entrypoint
RUN chmod +x /usr/local/bin/matterbridge-entrypoint
ENV QNAP_HOME_HUB_URL=http://127.0.0.1:8787
VOLUME ["/data"]
EXPOSE 8283 5540
ENTRYPOINT ["matterbridge-entrypoint"]
