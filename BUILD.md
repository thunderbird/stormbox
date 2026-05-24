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

Hosted stage/prod domains default to the Cloudflare edge bridge at
`infra/jmap-bridge/` configured in `src/defines.ts`. The Accounts menu link
is selected there too:

- `webmail.stage-thundermail.com` JMAP HTTP -> `https://jmap.stage-thundermail.com`
- `webmail.stage-thundermail.com` JMAP WS  -> `https://wsmail.stage-thundermail.com`
- `webmail.thundermail.com` JMAP HTTP -> `https://jmap.thundermail.com`
- `webmail.thundermail.com` JMAP WS  -> `https://wsmail.thundermail.com`
- dev/local -> `https://accounts-stage.tb.pro`
- hosted stage -> `https://accounts-stage.tb.pro`
- hosted prod -> `https://accounts.tb.pro`

To build against a different JMAP server or proxy, set
`VITE_JMAP_SERVER_URL` in `.env.local` or the build environment. To override
the Accounts menu link, set `VITE_ACCOUNTS_URL`.

```bash
VITE_JMAP_SERVER_URL=https://your-jmap-proxy-or-server.com
```

## Serving

`dist/` is static output and can be served by any static web host that supports
the deployment's HTTPS and routing requirements.
