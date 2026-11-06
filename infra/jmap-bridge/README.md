# Stormbox WebSocket authentication bridge

This Cloudflare Worker handles only `/jmap/ws` upgrades on
`jmap.stage-thundermail.com` and `jmap.thundermail.com`.
Session discovery, JMAP HTTP requests, uploads, and downloads go directly
to the corresponding `mail.*` Stalwart server, which supplies CORS headers.

## Authentication

Stalwart authenticates WebSocket upgrades through the `Authorization`
header. Browsers cannot set that header on `new WebSocket(url, protocols)`.
The client supplies exactly one credential on the upgrade URL:

- `?access_token=<jwt>` becomes `Authorization: Bearer <jwt>`.
- `?basic=<base64>` becomes `Authorization: Basic <base64>`.

The Worker removes both credential parameters and the `Cookie` header
before forwarding the upgrade. Other query parameters and the `jmap`
WebSocket subprotocol are preserved. Missing credentials return 401;
conflicting credentials return 400. Paths other than `/jmap/ws` return
404, and requests without a WebSocket upgrade return 426.

| Bridge hostname | Stalwart upstream |
|---|---|
| `jmap.stage-thundermail.com` | `https://mail.stage-thundermail.com` |
| `jmap.thundermail.com` | `https://mail.thundermail.com` |
| `*.workers.dev` | Stage by default; production with `X-Jmap-Bridge-Test-Upstream: prod` |

Unknown hostnames return 404. The upstream override header is ignored on
production custom domains. Observability is disabled in `wrangler.toml`
because upgrade URLs contain credentials; the Worker does not log requests.

## Files

- `src/index.ts`: selects the upstream and dispatches to the upgrade handler.
- `src/routes.ts`: fixed stage/production upstreams and workers.dev routing.
- `src/ws.ts`: WebSocket authentication and upgrade forwarding.
- `wrangler.toml`: deployment bindings and disabled observability.

## Deploy

Run Node/npm commands inside the development container, from this directory:

```bash
npm ci
npm run deploy              # workers.dev smoke deployment
npm run deploy:production   # stage and production custom domains
```

The deployment retains the `stormbox-jmap-bridge` Worker name and existing
custom domains, so publishing replaces the existing Worker. The default
deployment does not bind production hostnames. The production environment
binds both `jmap.stage-thundermail.com` and `jmap.thundermail.com`.

Deploy the frontend configuration that sends HTTP directly to Stalwart
before publishing this Worker: older frontends that still send HTTP to
`jmap.*` will receive 404 after the Worker update.

## Client configuration

`src/defines.ts` defaults HTTP to `https://mail.*.thundermail.com` and
WebSockets to `wss://jmap.*.thundermail.com/jmap/ws` for the hosted servers.
`VITE_JMAP_SERVER_URL` overrides the HTTP server;
`VITE_JMAP_WS_PROXY_URL` independently overrides the WebSocket auth bridge.
Local and custom servers default to `/jmap/ws` on the configured HTTP
server's origin. Session URLs are consumed as Stalwart advertises them.

## Smoke checks

Use a WebSocket client with the `jmap` subprotocol and a valid credential
to check the upgrade. A workers.dev deployment supports the same URL path
and credentials as the hosted bridge.

```bash
wscat -c "wss://jmap.stage-thundermail.com/jmap/ws?access_token=$JMAP_ACCESS_TOKEN" -s jmap
curl -i https://jmap.stage-thundermail.com/jmap/session  # 404
curl -i https://jmap.stage-thundermail.com/jmap/ws       # 426
```
