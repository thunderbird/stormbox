# Stormbox Webmail

A Vue 3 email client using JMAP (JSON Meta Application Protocol) for email.

## Quick Start

### Recommended: Dev Container

The easiest way to get started is using the dev container which provides a consistent environment:

```bash
# Start the dev container
docker compose -f .devcontainer/docker-compose.yml up -d

# Open in VS Code with Dev Containers extension, or run commands directly:
docker compose -f .devcontainer/docker-compose.yml exec app npm run dev
```

Access the app at **https://localhost:3000** (self-signed cert). Dev defaults to the
local Keycloak + Stalwart stack via `.env.development`; start it with
`cd thunderbird-accounts && docker compose up -d` then `npm run stack:seed` and
`npm run stack:ws-proxy &`.

### Local Setup (Alternative)

If you prefer local development:

```bash
# Clone and install
git clone <repository-url>
cd thundermail-vue
npm install

# Optional: override the built-in stage/prod JMAP Worker proxy
export VITE_JMAP_SERVER_URL="https://your-jmap-proxy-or-server.com"

# Start development server
npm run dev
```

## Configuration

Stormbox defaults to the Cloudflare JMAP Worker proxy for the hosted
stage/prod domains:

- `webmail.stage-thundermail.com` → `https://wsmail.stage-thundermail.com`
- `webmail.thundermail.com` → `https://wsmail.thundermail.com`

Override the endpoint when running against another server or proxy:

```bash
# Environment variable
export VITE_JMAP_SERVER_URL="https://your-jmap-proxy-or-server.com"

# Or create .env.local file
echo "VITE_JMAP_SERVER_URL=https://your-jmap-proxy-or-server.com" > .env.local
```

## Usage

1. **Login**: Enter your username and app password for the JMAP server
2. **Browse Mailboxes**: Use the sidebar to navigate between different mailboxes
3. **View Emails**: Click on emails in the message list to view their content
4. **Compose**: Click the "Compose" button to write new emails
5. **Reply/Delete**: Use the action buttons in the email detail view

## End-to-end tests

Clone with submodules so the local stack is available:

```bash
git clone --recurse-submodules <repository-url>
# or after clone:
git submodule update --init
```

**Smoke only** (no mail stack):

```bash
docker compose -f .devcontainer/docker-compose.yml exec app npm run test:e2e
```

**Full live suite** (Keycloak + Stalwart via `thunderbird-accounts/`). Stormbox
uses **HTTPS with a self-signed cert** so OPFS works; Vite proxies Keycloak and
Stalwart when `LOCAL_STACK=1`:

```bash
# Start stack (from repo root)
cd thunderbird-accounts && docker compose up --build -d

# One-time per fresh volume: http://localhost:8087 — sign in admin@example.org / admin,
# provision Thundermail. Then seed mail and WS proxy:
npm run stack:seed
npm run stack:ws-proxy &

# Run e2e inside dev container
docker compose -f .devcontainer/docker-compose.yml exec app \
  npm run test:e2e:local -- --project=chromium --project=firefox
```

Optional env overrides: copy `tests/e2e/.env.local.example` to `tests/e2e/.env.local`.

## Building for Production

See [BUILD.md](BUILD.md) for production build instructions.

## Project Structure

```
src/
├── components/         # Vue components
├── composables/        # Vue composables (main business logic)
├── services/          # JMAP client service
├── assets/           # Global styles and CSS variables
├── App.vue          # Main application component
└── main.js         # Application entry point
```

## Key Dependencies

- **Vue 3**: Modern reactive framework with Composition API
- **Vite**: Fast build tool and dev server
- **JMAP**: JSON Meta Application Protocol for email
- **Quill.js**: Rich text editor for email composition
- **@tanstack/vue-query**: Syncing client/server data state
- **@tanstack/vue-virtual**: High-performance virtual scrolling

