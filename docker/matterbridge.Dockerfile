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
ENV QNAPHOMEHUB_MATTERBRIDGE_PLUGIN=/usr/local/lib/node_modules/matterbridge-qnaphomehub
COPY matterbridge-plugin/package.json matterbridge-plugin/matterbridge-qnaphomehub.config.json ${QNAPHOMEHUB_MATTERBRIDGE_PLUGIN}/
COPY --from=plugin-build /app/plugin/dist ${QNAPHOMEHUB_MATTERBRIDGE_PLUGIN}/dist
COPY docker/matterbridge-bootstrap.mjs ${QNAPHOMEHUB_MATTERBRIDGE_PLUGIN}/matterbridge-bootstrap.mjs
# The plugin must use the exact Matterbridge instance that owns the platform.
# Link to the official global runtime instead of installing a second copy.
RUN mkdir -p ${QNAPHOMEHUB_MATTERBRIDGE_PLUGIN}/node_modules && \
    ln -s /usr/local/lib/node_modules/matterbridge ${QNAPHOMEHUB_MATTERBRIDGE_PLUGIN}/node_modules/matterbridge

COPY docker/matterbridge-entrypoint.sh /usr/local/bin/qnaphomehub-matterbridge-entrypoint
RUN chmod +x /usr/local/bin/qnaphomehub-matterbridge-entrypoint

ENV QNAP_HOME_HUB_URL=http://127.0.0.1:8787 \
    MATTERBRIDGE_HOMEDIR=/data

VOLUME ["/data"]
EXPOSE 8283 5540
ENTRYPOINT ["/usr/local/bin/qnaphomehub-matterbridge-entrypoint"]
