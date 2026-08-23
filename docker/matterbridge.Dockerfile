FROM node:24-bookworm AS plugin-build
WORKDIR /app/plugin
COPY matterbridge-plugin/package.json matterbridge-plugin/tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY matterbridge-plugin/src ./src
RUN npm run typecheck && npm run build

# Reuse Matterbridge's official, version-pinned Docker runtime. This preserves
# the upstream frontend, Matter runtime dependency layout and Docker healthcheck.
FROM luligu/matterbridge:3.10.6

USER root
COPY matterbridge-plugin/package.json matterbridge-plugin/matterbridge-qnaphomehub.config.json /usr/local/lib/node_modules/matterbridge-qnaphomehub/
COPY --from=plugin-build /app/plugin/dist /usr/local/lib/node_modules/matterbridge-qnaphomehub/dist
COPY docker/matterbridge-bootstrap.mjs /usr/local/lib/node_modules/matterbridge-qnaphomehub/matterbridge-bootstrap.mjs
COPY docker/matterbridge-entrypoint.sh /usr/local/bin/qnaphomehub-matterbridge-entrypoint
RUN chmod +x /usr/local/bin/qnaphomehub-matterbridge-entrypoint

ENV QNAP_HOME_HUB_URL=http://127.0.0.1:8787 \
    MATTERBRIDGE_HOMEDIR=/data \
    QNAPHOMEHUB_MATTERBRIDGE_PLUGIN=/usr/local/lib/node_modules/matterbridge-qnaphomehub

VOLUME ["/data"]
EXPOSE 8283 5540
ENTRYPOINT ["/usr/local/bin/qnaphomehub-matterbridge-entrypoint"]
