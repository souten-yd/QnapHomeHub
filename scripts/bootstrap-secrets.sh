#!/bin/sh
set -eu
mkdir -p secrets data/homehub data/matterbridge
chmod 700 secrets data 2>/dev/null || true
if [ ! -f secrets/homehub_admin_password.txt ]; then
  printf 'HomeHub admin password: '
  stty -echo; IFS= read -r PASS; stty echo; printf '\n'
  printf '%s\n' "$PASS" > secrets/homehub_admin_password.txt
fi
if [ ! -f secrets/homehub_internal_token.txt ]; then
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32 > secrets/homehub_internal_token.txt
  else dd if=/dev/urandom bs=32 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n' > secrets/homehub_internal_token.txt; printf '\n' >> secrets/homehub_internal_token.txt; fi
fi
for f in switchbot_token.txt switchbot_secret.txt; do [ -f "secrets/$f" ] || : > "secrets/$f"; done
[ -f secrets/switchbot_bot_passwords.json ] || printf '{}\n' > secrets/switchbot_bot_passwords.json
chmod 600 secrets/* 2>/dev/null || true
echo 'Secrets are ready under ./secrets'
