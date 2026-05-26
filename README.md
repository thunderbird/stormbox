# Stormbox Webmail

Stormbox is a prototype Vue 3 + Pinia webmail client backed by browser-local SQLite in a
`SharedWorker`. JMAP is the mail source of truth; the UI reads through the local
repository/cache layer and the sync backend keeps that cache current.

## Development

Use the dev container for all `npm`, `node`, `npx`, Playwright, and Vite
commands.

```bash
docker compose -f .devcontainer/docker-compose.yml up -d

docker compose -f .devcontainer/docker-compose.yml exec app bash -c \
  'cd /workspace && npm run dev'
```

Open **https://localhost:3000**. The dev server uses a self-signed certificate
so browser APIs required by Stormbox, including `SharedWorker` and local storage
APIs, are available.

## Local Mail Stack

Live development and full E2E tests use the `thunderbird-accounts/` submodule
for Keycloak and Stalwart.

```bash
./scripts/local-stack-up.sh
```

The helper initializes the submodule, starts the minimal local auth/mail stack
(Keycloak, Keycloak's Postgres, and Stalwart), starts the Stormbox dev
container, runs `stack:configure`, and starts the local JMAP WebSocket auth
proxy inside the dev container. Stalwart stores local mail in its own RocksDB
data directory; the Postgres service here is only Keycloak's database. To also
start the Thunderbird Accounts UI and its Django Postgres/Redis services, run
`WITH_ACCOUNTS=1 ./scripts/local-stack-up.sh`.

`stack:configure` is idempotent: it updates Keycloak for the HTTPS Vite origin,
provisions the dedicated Playwright account (`e2e@example.org`) directly in
Keycloak and Stalwart, and ensures the default developer Stalwart principal
(`admin@example.org`) exists without touching the Keycloak user imported by the
submodule. Local-stack E2E tests run the same configure step from Playwright
global setup, so a fresh test stack does not need a manual `stack:seed` step.

The developer account is kept separate from the Playwright account. Sign into
Stormbox manually as `admin@example.org` / `admin`. Optional test account
overrides live in `tests/e2e/.env.local.example`.

To populate that developer account with realistic-looking fake mail
(30 inbox messages plus 1500 archive messages by default) and ensure the account
has an `Archive` role folder, run:

```bash
docker compose -f .devcontainer/docker-compose.yml exec app bash -c \
  'cd /workspace && npm run stack:seed-dev'
```

The script is idempotent: re-running sweeps messages with its own `[dev seed]`
subject prefix and recreates them. It only touches the developer account; E2E
specs seed their own baseline inbox/archive data as needed.

## Configuration

The app defaults to the local stack during development through
`.env.development`: Vite keeps Stormbox on self-signed HTTPS and reverse-proxies
Keycloak, Stalwart JMAP HTTP, the local JMAP WebSocket auth bridge, and sender
avatar lookups through `https://localhost:3000`.

Hosted stage/prod builds use the Cloudflare edge bridge at `infra/jmap-bridge/`
by default. The bridge fronts the WebSocket auth contract on
`wsmail.*.thundermail.com` and the HTTP JMAP surface on
`jmap.*.thundermail.com` (with first-party CORS so the SPA at
`webmail.*.thundermail.com` can call it cross-origin). The app links and
transport defaults follow the current hostname:

- `webmail.stage-thundermail.com` JMAP HTTP -> `https://jmap.stage-thundermail.com`
- `webmail.stage-thundermail.com` JMAP WS -> `https://wsmail.stage-thundermail.com`
- `webmail.thundermail.com` JMAP HTTP -> `https://jmap.thundermail.com`
- `webmail.thundermail.com` JMAP WS -> `https://wsmail.thundermail.com`
- hosted sender avatars -> [`https://avatars.thunderbird.net`](https://avatars.thunderbird.net)
  ([thunderbird/avatars](https://github.com/thunderbird/avatars))
- dev/local product links -> stage services (`accounts-stage.tb.pro`,
  `appointment-stage.tb.pro`, `send-stage.tb.pro`)
- hosted stage product links -> stage services
- hosted prod product links -> production services

To point a local build at another JMAP server or proxy, set
`VITE_JMAP_SERVER_URL` and, when needed, `VITE_JMAP_WS_PROXY` in `.env.local`.
To override product links, set `VITE_ACCOUNTS_URL`, `VITE_APPOINTMENT_URL`, or
`VITE_SEND_URL`. To override sender logo lookup, set
`VITE_SENDER_AVATAR_PROXY_URL`; an empty value keeps the initials-only fallback.

```bash
VITE_JMAP_SERVER_URL=https://your-jmap-proxy-or-server.com
VITE_JMAP_WS_PROXY=https://your-ws-auth-bridge.com/jmap/ws
VITE_SENDER_AVATAR_PROXY_URL=https://your-avatar-proxy.com
```

## Common Commands

```bash
# Unit tests
docker compose -f .devcontainer/docker-compose.yml exec app bash -c \
  'cd /workspace && npm test'

# Type checking
docker compose -f .devcontainer/docker-compose.yml exec app bash -c \
  'cd /workspace && npm run typecheck'

# Smoke E2E tests
docker compose -f .devcontainer/docker-compose.yml exec app bash -c \
  'cd /workspace && npm run test:e2e'

# Local-stack E2E tests (Firefox by default; auto-configures the e2e account)
docker compose -f .devcontainer/docker-compose.yml exec app bash -c \
  'cd /workspace && npm run test:e2e:local'

# Full local-stack E2E tests, including Chromium
docker compose -f .devcontainer/docker-compose.yml exec app bash -c \
  'cd /workspace && npm run test:e2e:local:full'

# Production build
docker compose -f .devcontainer/docker-compose.yml exec app bash -c \
  'cd /workspace && npm run build'
```

The production bundle is written to `dist/`. That directory is static output and
can be served by any static web host that supports the deployment's HTTPS and
routing requirements.

## Documentation

- [Project docs](docs/README.md): architecture notes, storage design, research,
  and Spec Kit workflow links.
- [MVP scope spec](specs/001-mvp-scope/spec.md): current product-level MVP
  scope.
- [Agent guide](AGENTS.md): development rules for agents and contributors,
  including layer boundaries and test expectations.
- [Research benchmarks](research/README.md): opt-in performance and benchmark
  scripts.

## Project Layout

```text
src/
├── components/   # Vue components
├── composables/  # Vue composables
├── constants/    # Shared constants
├── db/           # SQLite engine, migrations, RPC handlers, repository client
├── services/     # Browser/service helpers
├── stores/       # Pinia stores
├── sync/         # Sync client and JMAP backend
├── types/        # TypeScript declarations
├── utils/        # Shared utilities
├── App.vue
└── main.ts
```

## Key Dependencies

- **Vue 3 + Pinia**: application UI and state.
- **Vite + TypeScript**: build and type-checking toolchain.
- **JMAP**: mail protocol for the MVP.
- **wa-sqlite**: browser-local SQLite storage.
- **Squire**: rich-text compose editor.
- **@tanstack/vue-virtual**: virtualized message lists.

