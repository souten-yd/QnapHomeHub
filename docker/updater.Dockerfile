FROM docker:27-cli AS dockercli

FROM node:24-alpine
WORKDIR /app
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY updater/app.mjs updater/radio-control.mjs updater/updater-handover.mjs updater/compose.radio-low-io.yaml ./
ENV UPDATER_BIND=127.0.0.1 UPDATER_PORT=8788 DATA_DIR=/data PROJECT_DIR=/project COMPOSE_PROJECT_NAME=qnaphomehub
VOLUME ["/data"]
CMD ["node", "app.mjs"]
