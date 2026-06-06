#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_COMPOSE=(docker compose -f .devcontainer/docker-compose.yml)
STACK_COMPOSE=(docker compose -f thunderbird-accounts/docker-compose.yml)
STACK_SERVICES=(kcpostgres keycloak stalwart)

ensure_keycloak_theme_static() {
  local static_dir="thunderbird-accounts/keycloak/themes/tbpro/static"
  local image_id=""
  local container_id=""

  echo "[local-stack] ensuring local Keycloak theme static assets"
  "${STACK_COMPOSE[@]}" build keycloak
  image_id="$("${STACK_COMPOSE[@]}" images -q keycloak)"
  if [[ -z "$image_id" ]] || ! docker image inspect "$image_id" >/dev/null 2>&1; then
    image_id="thunderbird-accounts-keycloak:latest"
  fi
  if ! docker image inspect "$image_id" >/dev/null 2>&1; then
    echo "[local-stack] could not resolve built Keycloak image" >&2
    exit 1
  fi

  mkdir -p "$static_dir"
  container_id="$(docker create "$image_id")"
  if ! docker cp "$container_id:/opt/keycloak/themes/tbpro/static/." "$static_dir/"; then
    docker rm "$container_id" >/dev/null
    echo "[local-stack] failed to copy Keycloak theme static assets" >&2
    exit 1
  fi
  docker rm "$container_id" >/dev/null
}

if [[ "${WITH_ACCOUNTS:-}" == "1" || "${WITH_ACCOUNTS:-}" == "true" ]]; then
  STACK_SERVICES=(postgres redis accounts mailpit "${STACK_SERVICES[@]}")
fi

echo "[local-stack] ensuring thunderbird-accounts submodule"
git submodule update --init thunderbird-accounts

stalwart_config="thunderbird-accounts/mail/etc/config.toml"
if [[ ! -f "$stalwart_config" ]] \
  || ! grep -q '%{env:ADMIN_SECRET}%' "$stalwart_config" \
  || ! grep -q 'anonymous = "10000/1m"' "$stalwart_config"; then
  echo "[local-stack] refreshing local Stalwart config for ADMIN_SECRET and rate-limit support"
  mkdir -p "$(dirname "$stalwart_config")"
  if ! cp thunderbird-accounts/config.toml.example "$stalwart_config" 2>/dev/null; then
    sudo cp thunderbird-accounts/config.toml.example "$stalwart_config"
  fi
fi

ensure_keycloak_theme_static

echo "[local-stack] starting local auth and mail services"
"${STACK_COMPOSE[@]}" up --build -d "${STACK_SERVICES[@]}"

echo "[local-stack] starting Stormbox dev container"
"${APP_COMPOSE[@]}" up -d app

echo "[local-stack] ensuring Playwright system dependencies"
"${APP_COMPOSE[@]}" exec -u root app bash -lc 'cd /workspace && npx playwright install-deps chromium firefox'

echo "[local-stack] ensuring Playwright browser binaries"
"${APP_COMPOSE[@]}" exec app bash -lc 'cd /workspace && npx playwright install chromium firefox'

echo "[local-stack] configuring local Keycloak and Stalwart"
for attempt in {1..12}; do
  if "${APP_COMPOSE[@]}" exec app bash -c 'cd /workspace && npm run stack:configure'; then
    break
  fi

  if [[ "$attempt" == "12" ]]; then
    echo "[local-stack] configure failed after $attempt attempts" >&2
    exit 1
  fi

  echo "[local-stack] stack not ready yet; retrying configure in 5s ($attempt/12)"
  sleep 5
done

echo "[local-stack] ensuring local JMAP WebSocket auth proxy"
"${APP_COMPOSE[@]}" exec app bash -lc '
  cd /workspace
  pid_file=/tmp/stormbox-ws-proxy.pid
  if [[ -r "$pid_file" ]]; then
    pid="$(cat "$pid_file")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "[local-stack] ws proxy already running as pid $pid"
      exit 0
    fi
  fi

  nohup npm run stack:ws-proxy >/tmp/ws-proxy.log 2>&1 &
  echo "$!" >"$pid_file"
  echo "[local-stack] ws proxy started; log: /tmp/ws-proxy.log"
'

cat <<'EOF'
[local-stack] ready

Open Stormbox at https://localhost:3000 after starting the dev server:
  docker compose -f .devcontainer/docker-compose.yml exec app bash -c 'cd /workspace && npm run dev'
EOF

if [[ "${WITH_ACCOUNTS:-}" == "1" || "${WITH_ACCOUNTS:-}" == "true" ]]; then
  echo "Accounts UI: http://localhost:8087"
else
  echo "Accounts UI not started. Re-run with WITH_ACCOUNTS=1 if you need it."
fi
