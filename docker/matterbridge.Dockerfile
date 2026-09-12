ARG MATTERBRIDGE_VERSION=3.10.8
ARG HOMEHUB_VERSION=0.0.0

FROM node:24-bookworm AS plugin-build
ARG MATTERBRIDGE_VERSION
WORKDIR /app/plugin
COPY matterbridge-plugin/package.json matterbridge-plugin/tsconfig.json ./
RUN npm install --no-audit --no-fund && npm install --no-audit --no-fund --no-save matterbridge@${MATTERBRIDGE_VERSION}
COPY matterbridge-plugin/src ./src
RUN npm run typecheck && npm run build && \
    npm pkg delete devDependencies scripts

# The Matterbridge base is selected by CI. Only versions that pass the
# QnapHomeHub integration smoke are published as matterbridge-tested.
FROM luligu/matterbridge:${MATTERBRIDGE_VERSION}
ARG MATTERBRIDGE_VERSION
ARG HOMEHUB_VERSION

USER root
ENV QNAPHOMEHUB_MATTERBRIDGE_PLUGIN=/usr/local/lib/node_modules/matterbridge-qnaphomehub \
    QNAPHOMEHUB_MATTERBRIDGE_VERSION=${MATTERBRIDGE_VERSION} \
    QNAPHOMEHUB_VERSION=${HOMEHUB_VERSION}
LABEL org.opencontainers.image.version=${MATTERBRIDGE_VERSION} \
      io.qnaphomehub.component=matterbridge
COPY --from=plugin-build /app/plugin/package.json ${QNAPHOMEHUB_MATTERBRIDGE_PLUGIN}/package.json
COPY matterbridge-plugin/matterbridge-qnaphomehub.config.json ${QNAPHOMEHUB_MATTERBRIDGE_PLUGIN}/
COPY --from=plugin-build /app/plugin/dist ${QNAPHOMEHUB_MATTERBRIDGE_PLUGIN}/dist
COPY docker/matterbridge-bootstrap.mjs ${QNAPHOMEHUB_MATTERBRIDGE_PLUGIN}/matterbridge-bootstrap.mjs
RUN mkdir -p ${QNAPHOMEHUB_MATTERBRIDGE_PLUGIN}/node_modules && \
    ln -s /usr/local/lib/node_modules/matterbridge ${QNAPHOMEHUB_MATTERBRIDGE_PLUGIN}/node_modules/matterbridge

COPY docker/matterbridge-entrypoint.sh /usr/local/bin/qnaphomehub-matterbridge-entrypoint
RUN chmod +x /usr/local/bin/qnaphomehub-matterbridge-entrypoint

ENV QNAP_HOME_HUB_URL=http://127.0.0.1:8787 \
    MATTERBRIDGE_HOMEDIR=/data

VOLUME ["/data"]
EXPOSE 8283 5540
ENTRYPOINT ["/usr/local/bin/qnaphomehub-matterbridge-entrypoint"]
