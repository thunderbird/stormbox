# Stormbox Webmail

Stormbox is a prototype Vue 3 + Pinia webmail client backed by browser-local SQLite in a
`SharedWorker`. JMAP is the source of truth; the UI reads through the local
repository/cache layer and the sync backend keeps that cache current.

This is an experiment! In addition to the experimental sqlite backend, this project is experimenting with spec-based development. You can find the [spec here](specs/001-mvp-scope/spec.md). There are also [architecture docs](docs/README.md) and [research benchmarks](research/README.md).

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
container, runs `stack:configure`, and starts the local WebSocket auth bridge
(the WS half of the same contract as `infra/jmap-bridge/`) inside the dev
container. Stalwart stores local mail in its own RocksDB data directory; the
Postgres service here is only Keycloak's database. To also start the Thunderbird
Accounts UI and its Django Postgres/Redis services, run
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
Keycloak, Stalwart JMAP HTTP (`/stalwart-jmap`), the local WebSocket auth
bridge (`/jmap/ws`), and sender avatar lookups through `https://localhost:3000`.

Hosted stage/prod builds use a single Cloudflare Worker at `infra/jmap-bridge/`
by default. That bridge fronts both halves of JMAP transport on
`jmap.*.thundermail.com`: HTTP JMAP with first-party CORS, plus the
`/jmap/ws` WebSocket auth bridge. The app links and transport defaults follow
the current hostname:

- `webmail.stage-thundermail.com` -> `https://jmap.stage-thundermail.com`
  (HTTP) and `wss://jmap.stage-thundermail.com/jmap/ws` (WS)
- `webmail.thundermail.com` -> `https://jmap.thundermail.com` (HTTP) and
  `wss://jmap.thundermail.com/jmap/ws` (WS)
- hosted sender avatars -> [`https://avatars.thunderbird.net`](https://avatars.thunderbird.net)
  ([thunderbird/avatars](https://github.com/thunderbird/avatars))
- dev/local product links -> stage services (`accounts-stage.tb.pro`,
  `appointment-stage.tb.pro`, `send-stage.tb.pro`)
- hosted stage product links -> stage services
- hosted prod product links -> production services

To point a local build at another JMAP server or bridge, set
`VITE_JMAP_SERVER_URL` in `.env.local`. The WebSocket auth bridge URL is derived
from the same origin with `/jmap/ws`.
To override product links, set `VITE_ACCOUNTS_URL`, `VITE_APPOINTMENT_URL`, or
`VITE_SEND_URL`. To override sender logo lookup, set
`VITE_SENDER_AVATAR_PROXY_URL`; an empty value keeps the initials-only fallback.

```bash
VITE_JMAP_SERVER_URL=https://your-jmap-bridge-or-server.com
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
stormbox/
├── src/                      # Vue app source
│   ├── assets/               # Static assets (icons)
│   ├── components/           # Vue components
│   ├── composables/          # Vue composables
│   ├── constants/            # Shared constants
│   ├── db/                   # SQLite SharedWorker, migrations, RPC handlers
│   ├── services/             # Auth and browser helpers
│   ├── stores/               # Pinia stores
│   ├── sync/                 # Sync host/client and JMAP backend
│   │   └── backends/jmap/    # JMAP transport, session, outbox, indexers
│   ├── types/                # TypeScript declarations
│   ├── utils/                # Shared utilities
│   ├── App.vue
│   ├── defines.ts            # Env and product URL config
│   └── main.ts
├── tests/
│   ├── e2e/                  # Playwright specs and helpers
│   ├── fixtures/             # Stack configure/seed scripts, local WS auth bridge
│   └── unit/                 # Vitest tests (mirrors src layout)
├── infra/
│   └── jmap-bridge/          # Unified Cloudflare Worker (HTTP JMAP + WS auth)
├── scripts/
│   └── local-stack-up.sh     # Dev container + auth/mail stack bootstrap
├── docs/                     # Architecture notes and doc index
├── specs/                    # Spec Kit feature specs
├── research/                 # Benchmark scripts and perf experiments
├── thunderbird-accounts/     # Git submodule (Keycloak, Stalwart, Accounts UI)
├── .devcontainer/            # Dev container definition
├── .specify/                 # Spec Kit templates and constitution
└── public/                   # Static PWA assets (favicons, icons)
```

## Key Dependencies

- **Vue 3 + Pinia**: application UI and state.
- **Vite + TypeScript**: build and type-checking toolchain.
- **JMAP**: mail protocol for the MVP.
- **wa-sqlite**: browser-local SQLite storage.
- **Squire**: rich-text compose editor.
- **@tanstack/vue-virtual**: virtualized message lists.

