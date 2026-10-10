#!/bin/sh
# Explicit quiet-state trial. Only these four HomeHub Docker services are touched.
# Compose config is intentionally not read: QNAP SSH users may lack permissions.
set -eu

usage() {
  echo "Usage: sh scripts/qnap-quiet-eval.sh status|stop|restore"
  echo "  status: read-only Docker status; also check QnapSelfCare via App Center"
  echo "  stop:   set restart=no and stop all four HomeHub containers"
  echo "  restore: restore default unless-stopped and start all four (only after QPKG is disabled)"
  exit 2
}

case "${1:-}" in status|stop|restore) action=$1 ;; *) usage ;; esac
[ "$#" -eq 1 ] || usage
command -v docker >/dev/null 2>&1 || { echo 'Docker CLI unavailable' >&2; exit 1; }

containers='qnaphomehub-updater qnaphomehub-matterbridge qnaphomehub qnaphomehub-radio'
# Docker object labels are mandatory. Do not touch unrelated containers by name.
for name in $containers; do
  project=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$name") || exit 1
  service=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$name") || exit 1
  case "$name:$project:$service" in
    qnaphomehub:qnaphomehub:homehub|qnaphomehub-radio:qnaphomehub:radio|qnaphomehub-updater:qnaphomehub:updater|qnaphomehub-matterbridge:qnaphomehub:matterbridge) ;;
    *) echo "Unexpected Docker ownership for $name: project=$project service=$service; aborting" >&2; exit 1 ;;
  esac
done

case "$action" in
  status)
    for name in $containers; do
      docker inspect --format '{{.Name}} {{.State.Status}} restart={{.HostConfig.RestartPolicy.Name}}' "$name"
    done
    echo 'QnapSelfCare is managed by QTS App Center; stop it there before quiet evaluation.'
    echo 'Disk IOPS test: python3 native/quiet_eval.py --seconds 60 --devices sda sdb'
    ;;
  stop)
    echo 'Stopping only HomeHub Docker services; SelfCare data and pairing keys are unchanged.'
    echo 'Stop QnapSelfCare QPKG in App Center first to avoid reconnection writes.'
    for name in $containers; do
      docker update --restart=no "$name"
      docker stop "$name"
    done
    for name in $containers; do
      docker inspect --format '{{.Name}} {{.State.Status}} restart={{.HostConfig.RestartPolicy.Name}}' "$name"
    done
    ;;
  restore)
    echo 'If a QnapHomeHub QPKG is running, stop it in App Center BEFORE restoring port 8787.'
    # Check if a local server owns the port; fail closed rather than start a second Web.
    if command -v /opt/bin/python3.11 >/dev/null 2>&1; then
      /opt/bin/python3.11 -c 'import socket; s=socket.socket(); s.bind(("0.0.0.0",8787)); s.close()' || {
        echo 'TCP 8787 already bound; refusing concurrent Docker Web start.' >&2
        exit 1
      }
    elif command -v python3 >/dev/null 2>&1; then
      python3 -c 'import socket; s=socket.socket(); s.bind(("0.0.0.0",8787)); s.close()' || {
        echo 'TCP 8787 already bound; refusing concurrent Docker Web start.' >&2
        exit 1
      }
    else
      echo 'Python required for safe port 8787 check before restore' >&2
      exit 1
    fi
    # Restore baseline Compose restart policy, not the modified user policy.
    for name in qnaphomehub-radio qnaphomehub qnaphomehub-matterbridge qnaphomehub-updater; do
      docker update --restart=unless-stopped "$name"
      docker start "$name"
    done
    ;;
esac
