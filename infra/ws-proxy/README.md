# stormbox-ws-proxy

A Cloudflare Worker that lets browser clients open authenticated JMAP
WebSocket connections to Stalwart.

## Why it exists

Stalwart's `/jmap/ws` endpoint authenticates only via the
`Authorization` HTTP header on the WebSocket upgrade request. The
browser `WebSocket` API doesn't allow setting custom headers on a
`new WebSocket(url, protocols)` call, so a browser-only client cannot
attach a bearer token to that handshake. Until Stalwart accepts an
upstream patch for RFC 6750 §2.3 (access_token query parameter) on
`/jmap/ws`, this worker provides the same behavior at the edge:

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
Stalwart logs (the worker strips it before forwarding), and is
excluded from Cloudflare access logs.

## Bound at

`wsmail.stage-thundermail.com` (Workers Custom Domain managed by
`wrangler.toml`). DNS is provisioned automatically by Cloudflare when
the worker is deployed against this config.

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
wscat -c "wss://wsmail.stage-thundermail.com/jmap/ws?access_token=$(cat /tmp/jwt)" -s jmap
> {"@type":"WebSocketPushEnable","dataTypes":["Mailbox","Email"]}
```

## Client wiring

Stormbox's `JmapTransport.openWebSocket()` constructs the URL like:

```js
const wsUrl = new URL(import.meta.env.VITE_JMAP_WS_PROXY ?? wsCap.url);
wsUrl.searchParams.set('access_token', bearer);
new WebSocket(wsUrl.toString(), ['jmap']);
```

so the proxy is opt-in via `VITE_JMAP_WS_PROXY` and trivially
removable once Stalwart accepts the upstream patch.

## Tail logs

```bash
wrangler tail
```
