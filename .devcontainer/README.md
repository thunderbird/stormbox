# Stormbox Docker Dev Service

This directory defines the local Docker service used for Stormbox development.
It can be attached to as a VS Code/Cursor devcontainer, but it is also useful as
a plain Docker Compose service. The running container is named
`thundermail-dev`, mounts the project at `/workspace`, and exposes Vite on
`https://localhost:3000`.

## Quick Start

From the Stormbox repo root:

```bash
./scripts/local-stack-up.sh

docker compose -f .devcontainer/docker-compose.yml exec app bash -c \
  'cd /workspace && npm run dev'
```

Open **https://localhost:3000** and accept the self-signed certificate once.

`./scripts/local-stack-up.sh` starts the minimal local auth/mail stack
(Keycloak, Keycloak's Postgres, and Stalwart), starts `thundermail-dev`, runs
the local Keycloak/Stalwart configure step, and starts the local JMAP WebSocket
auth proxy inside the container. Stalwart stores local mail in RocksDB; Postgres
is only for Keycloak unless you opt into the Thunderbird Accounts UI with
`WITH_ACCOUNTS=1 ./scripts/local-stack-up.sh`. Dev defaults live in
`.env.development` and route Keycloak, Stalwart JMAP, WebSocket auth, and sender
avatar requests through the HTTPS Vite origin.

## Optional Devcontainer Attach

If you open the repo through VS Code or Cursor's devcontainer support:

- `postCreateCommand` runs `npm ci` and installs the Chromium/Firefox
  Playwright browser binaries used by the local E2E suite.
- `postAttachCommand` starts `npm run dev`.
- Port `3000` is forwarded as the Vite dev server.

If you use Docker Compose directly instead of the IDE devcontainer lifecycle,
run dependency and app commands explicitly inside the container:

```bash
docker compose -f .devcontainer/docker-compose.yml exec app bash -c \
  'cd /workspace && npm ci'
```

## Files

- `devcontainer.json`: optional VS Code/Cursor attach settings, extensions,
  forwarded ports, and lifecycle commands.
- `docker-compose.yml`: defines `thundermail-dev`, mounts the repo and SSH keys,
  sets local-stack Vite environment variables, and maps ports `3000`, `5173`,
  and `9229`.
- `Dockerfile`: development image matching the project Node version, with git, build tools, and
  global npm tooling.

## Common Commands

Run Node/Vite/Playwright commands inside `thundermail-dev`:

```bash
docker compose -f .devcontainer/docker-compose.yml exec app bash -c \
  'cd /workspace && npm test'

docker compose -f .devcontainer/docker-compose.yml exec app bash -c \
  'cd /workspace && npm run build'
```

## Stage Overrides

The default local environment uses the local stack. To point a local build at
stage instead, override the JMAP bridge endpoint:

```bash
VITE_JMAP_SERVER_URL=https://jmap.stage-thundermail.com
```

## Troubleshooting

- Verify Docker is running with `docker ps`.
- If `https://localhost:3000` is unavailable, check whether `thundermail-dev` is
  running and whether another process already owns port `3000`.
- If local-stack auth or JMAP calls fail, re-run `./scripts/local-stack-up.sh`.
- If dependencies are missing after starting with plain Docker Compose, run
  `npm ci` inside the container.

## Resources

- [Project README](../README.md)
