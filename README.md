# Stormbox Webmail

Stormbox is a Vue 3 + Pinia webmail client backed by browser-local SQLite in a
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
for Keycloak, Stalwart, and Accounts services.

```bash
git submodule update --init

cd thunderbird-accounts
docker compose up --build -d
cd ..

docker compose -f .devcontainer/docker-compose.yml exec app bash -c \
  'cd /workspace && npm run stack:seed'

docker compose -f .devcontainer/docker-compose.yml exec -d app bash -c \
  'cd /workspace && npm run stack:ws-proxy >/tmp/ws-proxy.log 2>&1'
```

On a fresh stack, first open **http://localhost:8087**, sign in as
`admin@example.org` / `admin`, and provision a Thundermail address. Optional
test account overrides live in `tests/e2e/.env.local.example`.

## Configuration

The app defaults to the local stack during development through
`.env.development`. Hosted stage/prod builds use the Cloudflare JMAP Worker
proxy by default, and the app menu points at the matching Thunderbird
Accounts environment:

- `webmail.stage-thundermail.com` -> `https://wsmail.stage-thundermail.com`
- `webmail.thundermail.com` -> `https://wsmail.thundermail.com`
- dev/local -> `https://accounts-stage.tb.pro`
- hosted stage -> `https://accounts-stage.tb.pro`
- hosted prod -> `https://accounts.tb.pro`

To point a local build at another JMAP server or proxy, set
`VITE_JMAP_SERVER_URL` in `.env.local`. To override the Accounts menu link,
set `VITE_ACCOUNTS_URL`.

```bash
VITE_JMAP_SERVER_URL=https://your-jmap-proxy-or-server.com
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

# Full local-stack E2E tests
docker compose -f .devcontainer/docker-compose.yml exec app bash -c \
  'cd /workspace && npm run test:e2e:local -- --project=chromium --project=firefox'

# Production build
docker compose -f .devcontainer/docker-compose.yml exec app bash -c \
  'cd /workspace && npm run build'
```

See [BUILD.md](BUILD.md) for production build notes.

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

