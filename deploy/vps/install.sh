#!/usr/bin/env bash
# Установка тестового сервера «Близкие» P0 на чистый VPS (Ubuntu 22.04/24.04), запускать от root:
#   curl -fsSL https://raw.githubusercontent.com/<ВЛАДЕЛЕЦ>/<РЕПО>/main/deploy/vps/install.sh | bash -s -- https://github.com/<ВЛАДЕЛЕЦ>/<РЕПО>.git
# или вручную: git clone ... && cd repo/deploy/vps && bash install.sh
set -euo pipefail

REPO_URL="${1:-}"
if ! command -v docker >/dev/null; then
  apt-get update -y && apt-get install -y ca-certificates curl git
  curl -fsSL https://get.docker.com | sh
fi
if [ -n "$REPO_URL" ] && [ ! -d /opt/blizkie ]; then
  git clone --depth 1 "$REPO_URL" /opt/blizkie
fi
cd "${REPO_DIR:-/opt/blizkie}/deploy/vps" 2>/dev/null || cd "$(dirname "$0")"

if [ ! -f .env ]; then
  IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
  cat > .env <<EOF
DOMAIN=${IP}.sslip.io
POSTGRES_PASSWORD=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
ADMIN_TOKEN=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)
REGISTRATION_KEY=
LOCATION_TTL_HOURS=24
PUSH_PROVIDER=none
EOF
  chmod 600 .env
fi
docker compose up -d --build
. ./.env
echo "Ждём сертификат и запуск..."
for i in $(seq 1 60); do
  if curl -fsS "https://${DOMAIN}/health" >/dev/null 2>&1; then
    echo "ГОТОВО. Адрес сервера для приложения: https://${DOMAIN}"
    echo "ADMIN_TOKEN (для выгрузки результатов) хранится в $(pwd)/.env"
    exit 0
  fi
  sleep 5
done
echo "Сервер не ответил по https://${DOMAIN}/health за 5 минут. Проверьте: docker compose logs --tail=50"
exit 1
