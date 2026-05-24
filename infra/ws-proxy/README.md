# stormbox-ws-proxy

A Cloudflare Worker that bridges the WebSocket authentication contract
for Stormbox stage/prod. It does nothing else.

## Why it exists

Stalwart's `/jmap/ws` endpoint authenticates the WebSocket upgrade via
the HTTP `Authorization` header. The browser `WebSocket` API does not
let callers set arbitrary headers on `new WebSocket(url, protocols)`,
so the credential rides in on the upgrade URL and this Worker turns it
into an `Authorization` header before forwarding upstream:

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

JMAP HTTP traffic (the session document, `/jmap/api`, etc.) is not
proxied here. Browsers talk to Stalwart directly at
`mail.stage-thundermail.com` / `mail.thundermail.com`, which is
expected to send CORS headers for the webmail origins. Sender-domain
avatars live behind `https://avatars.thunderbird.net`. Neither passes
through this Worker.

## Logging

Workers observability is disabled (`[observability] enabled = false` in
`wrangler.toml`) so the upgrade URL (which contains the bearer token
until this Worker strips it) is never written to Cloudflare Logs. The
Worker itself does not call `console.*`. Stalwart never sees the
credential in the URL because both `access_token` and `basic` are
removed before the upstream request is built.

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

## Verify

```bash
wscat -c "wss://wsmail.stage-thundermail.com/jmap/ws?access_token=$(cat /tmp/jwt)" -s jmap
> {"@type":"WebSocketPushEnable","dataTypes":["Mailbox","Email"]}
```

Any non-WebSocket request gets `426 Upgrade Required`.

## Client wiring

Stormbox defaults are host-aware:

- `webmail.stage-thundermail.com` uses `https://wsmail.stage-thundermail.com/jmap/ws`
- `webmail.thundermail.com` uses `https://wsmail.thundermail.com/jmap/ws`

`VITE_JMAP_WS_PROXY` overrides the default. `JmapTransport.openWebSocket()`
constructs the URL like:

```js
const wsUrl = new URL(import.meta.env.VITE_JMAP_WS_PROXY ?? wsCap.url);
wsUrl.searchParams.set('access_token', bearer);
new WebSocket(wsUrl.toString(), ['jmap']);
```
