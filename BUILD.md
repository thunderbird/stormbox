# Build Instructions

Build Stormbox from the dev container. Do not run `npm`, `node`, `npx`, Vite, or
Playwright commands on the host for this repo.

```bash
docker compose -f .devcontainer/docker-compose.yml up -d

docker compose -f .devcontainer/docker-compose.yml exec app bash -c \
  'cd /workspace && npm run build'
```

The production bundle is written to `dist/`.

## Configuration

Hosted stage/prod domains default to the Cloudflare JMAP Worker proxy configured
in `src/defines.ts`:

- `webmail.stage-thundermail.com` -> `https://wsmail.stage-thundermail.com`
- `webmail.thundermail.com` -> `https://wsmail.thundermail.com`

To build against a different JMAP server or proxy, set
`VITE_JMAP_SERVER_URL` in `.env.local` or the build environment.

```bash
VITE_JMAP_SERVER_URL=https://your-jmap-proxy-or-server.com
```

## Serving

`dist/` is static output and can be served by any static web host that supports
the deployment's HTTPS and routing requirements.
