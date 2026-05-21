# stormbox-ws-proxy

A Cloudflare Worker that proxies the scoped Stalwart JMAP surface for
Stormbox stage/prod.

## Why it exists

The web app runs at `webmail.stage-thundermail.com` and
`webmail.thundermail.com`, while Stalwart serves JMAP from
`mail.stage-thundermail.com` and `mail.thundermail.com`. Rather than
restarting Stalwart to change CORS settings, browsers talk to this
Worker. The Worker forwards only:

- `/.well-known/jmap`
- `/jmap`
- `/jmap/*`

and adds CORS headers for the webmail origins.

It also keeps the WebSocket auth bridge. Stalwart's `/jmap/ws`
endpoint authenticates only via the `Authorization` HTTP header on the
WebSocket upgrade request. The browser `WebSocket` API doesn't allow
setting custom headers on a `new WebSocket(url, protocols)` call, so
the Worker accepts the credential in the WebSocket URL and sets the
upstream header:

```
Browser  ───►  wsmail.stage-thundermail.com/jmap/ws?access_token=<jwt>
                                │
                                ▼   (CF Worker)
                  strip access_token; set Authorization: Bearer <jwt>
                                │
                                ▼
                  mail.stage-thundermail.com/jmap/ws
                  (Stalwart, unchanged)
```

The token only ever appears inside encrypted TLS payloads, never in
Stalwart logs (the Worker strips it before forwarding), and is excluded
from Cloudflare access logs.

## Bound at

- `wsmail.stage-thundermail.com` → `mail.stage-thundermail.com`
- `wsmail.thundermail.com` → `mail.thundermail.com`

Both are Workers Custom Domains managed by `wrangler.toml`. DNS is
provisioned automatically by Cloudflare when the Worker is deployed
against this config.

## Deploy

```bash
cd stormbox/infra/ws-proxy
npm install                              # one time
CLOUDFLARE_API_TOKEN=<token> wrangler deploy
```

If you only have a legacy global API key (`CF_KEY` + `CF_EMAIL`),
wrangler also accepts those via env.

Verify:

```bash
curl -i \
  -H "Origin: https://webmail.stage-thundermail.com" \
  https://wsmail.stage-thundermail.com/.well-known/jmap

wscat -c "wss://wsmail.stage-thundermail.com/jmap/ws?access_token=$(cat /tmp/jwt)" -s jmap
> {"@type":"WebSocketPushEnable","dataTypes":["Mailbox","Email"]}
```

## Client wiring

Stormbox defaults are host-aware:

- `webmail.stage-thundermail.com` uses `https://wsmail.stage-thundermail.com`
- `webmail.thundermail.com` uses `https://wsmail.thundermail.com`

`VITE_JMAP_SERVER_URL` and `VITE_JMAP_WS_PROXY` still override those
defaults. `JmapTransport.openWebSocket()` constructs the URL like:

```js
const wsUrl = new URL(import.meta.env.VITE_JMAP_WS_PROXY ?? wsCap.url);
wsUrl.searchParams.set('access_token', bearer);
new WebSocket(wsUrl.toString(), ['jmap']);
```

The session document is proxied too; the Worker rewrites Stalwart's
advertised JMAP URLs from `mail.*` back to `wsmail.*`, so follow-up
HTTP calls stay on the proxy.

## Tail logs

```bash
wrangler tail
```
