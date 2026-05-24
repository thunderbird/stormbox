# stormbox-jmap-bridge

A single Cloudflare Worker that fronts both halves of Stormbox's
JMAP transport on dedicated bridge hostnames: the WebSocket auth
bridge on `wsmail.*.thundermail.com`, and the HTTP proxy with
first-party CORS on `jmap.*.thundermail.com`.

## Why it exists

**WebSocket half.** Stalwart authenticates the `/jmap/ws` upgrade
via the `Authorization` header. Browsers cannot set arbitrary
headers on `new WebSocket(url, protocols)`. The client puts the
credential on the upgrade URL; this Worker promotes it to a header
on the upstream upgrade.

**HTTP half.** Stalwart's CORS is binary: off, or fully permissive
`*`. We cannot configure a list of allowed origins. We also cannot
put `mail.thundermail.com` behind Cloudflare's HTTP proxy because
that DNS name must keep serving IMAP / SMTP / POP / Submission on
non-HTTP ports. Instead the Worker serves the JMAP HTTP surface
from a dedicated hostname (`jmap.*.thundermail.com`) and handles
CORS itself: it allowlists the SPA's webmail origins (plus
`localhost:3000` on stage for vite dev), echoes back the request
`Origin` only when it matches, and short-circuits preflights at the
edge so Stalwart's CORS settings never reach the browser.

```
Browser ─ WS upgrade ───►  wsmail.thundermail.com/jmap/ws?access_token=<jwt>
                                        │
                                        ▼  (this Worker, ws.ts)
                          strip access_token / basic from URL
                          set Authorization: Bearer/Basic
                          delete Cookie
                                        │
                                        ▼
                              mail.thundermail.com/jmap/ws
                              (Stalwart, unchanged)
```

```
SPA at webmail.* ─ HTTP ─►  jmap.thundermail.com/jmap/api
                                        │
                                        ▼  (this Worker, http.ts)
                          on OPTIONS: short-circuit, return CORS
                              preflight; never hits Stalwart
                          on other methods:
                            delete Cookie + CF meta headers
                            forward preserving method/headers/body
                            rewrite session-document URLs:
                              apiUrl / uploadUrl / downloadUrl /
                              eventSourceUrl → jmap.*
                              urn:ietf:params:jmap:websocket
                                capability url → wsmail.*
                            rewrite absolute Location headers
                            merge Access-Control-Allow-Origin into
                              the response
                                        │
                                        ▼
                              mail.thundermail.com/jmap/api
                              (Stalwart, unchanged)
```

## CORS contract

The HTTP half is genuinely cross-origin: the SPA lives at
`webmail.*.thundermail.com`, the bridge at `jmap.*.thundermail.com`.
This is deliberate — it lets the SPA hosting (GitHub Pages,
grey-cloud DNS) stay completely untouched. The Worker owns CORS:

| Header | Value |
|---|---|
| `Access-Control-Allow-Origin` | echo of `Origin` when in allowlist; absent otherwise |
| `Vary` | `Origin` |
| `Access-Control-Allow-Methods` (preflight) | `GET, HEAD, POST, OPTIONS` |
| `Access-Control-Allow-Headers` (preflight) | `Authorization, Content-Type, Accept` |
| `Access-Control-Max-Age` (preflight) | `3600` |
| `Access-Control-Allow-Credentials` | not set — JMAP auth is `Authorization`, not cookies |

Allowlist per environment (defined in `routes.ts`):

- **Stage**: `https://webmail.stage-thundermail.com`, `https://localhost:3000`, `http://localhost:3000`
- **Prod**: `https://webmail.thundermail.com` (strict, no dev origin)

Unknown origins receive no `Access-Control-*` headers; the browser
will block the response from reaching the SPA, which is the desired
behaviour. The Worker is never an open CORS oracle.

## What the two halves share

- Same upstream selection (`mail.*` stage/prod by hostname).
- Same observability-off requirement; both flow `Authorization`.
- Same `Cookie` strip before upstream — JMAP auth is
  Authorization-only, SPA cookies have no business at the mail
  server.
- Same defensive 4xx for unknown paths and wrong protocol shape
  per hostname.
- Same trust boundary, same vendor, same TLS, same egress.

## Dispatch model

Dispatch is by **hostname**, not by request inspection. A request
to `wsmail.*` only reaches `ws.ts`; a request to `jmap.*` only
reaches `http.ts`. The handlers do not share request-handling code.
The host classifier lives in `src/routes.ts`.

| Hostname           | Reaches    | Wrong-shape response |
|--------------------|------------|----------------------|
| `wsmail.*`         | `ws.ts`    | 426 if not a WS upgrade |
| `jmap.*`           | `http.ts`  | 426 if a WS upgrade (defense in depth — Cloudflare strips Upgrade on HTTP/2, so this only fires on HTTP/1.1) |
| `*.workers.dev`    | both       | dispatched by request `Upgrade` header (test mode) |
| anything else      | none       | 404 |

## File layout

```
infra/jmap-bridge/
├── README.md           # this file
├── package.json
├── tsconfig.json
├── wrangler.toml
└── src/
    ├── index.ts        # dispatcher (hostname → handler)
    ├── routes.ts       # Route + CORS allowlist + selectRoute + classifyHost
    ├── ws.ts           # WebSocket upgrade auth bridge
    └── http.ts         # HTTP proxy + CORS + session-URL rewrite
```

## Deploy targets

| Command                       | What it does                                              | When to use            |
|-------------------------------|-----------------------------------------------------------|------------------------|
| `npm run deploy`              | Publish to `*.workers.dev` only. No production hostname.  | Local smoke testing.   |
| `npm run deploy:production`   | Publish under `[env.production]`, binding all four custom domains. | Real production deploy.|

The default `wrangler deploy` cannot accidentally claim a
production hostname — those only fire under the production env.

For `--env production` the `thundermail.com` and
`stage-thundermail.com` zones must live in this Cloudflare account.
Cloudflare manages the DNS records for the four custom domains
automatically when the Worker is deployed against this config.
**The SPA at `webmail.*.thundermail.com` does not need to be
proxied through Cloudflare** — it stays on GitHub Pages with
grey-cloud DNS, untouched.

## Deploy

```bash
cd stormbox/infra/jmap-bridge
npm install                              # one time

# Smoke test (default env, *.workers.dev only):
CLOUDFLARE_API_TOKEN=<token> npm run deploy

# Production (gated):
CLOUDFLARE_API_TOKEN=<token> npm run deploy:production
```

## Smoke test recipes

After `npm run deploy`, the Worker is reachable at a
`*.workers.dev` URL. From curl:

```bash
BRIDGE=https://stormbox-jmap-bridge.<account>.workers.dev

# Stage session via bridge (default upstream)
curl -sS -u "sancus@stage-thundermail.com:$SANCUS_STAGE_THUNDERMAIL" \
  $BRIDGE/jmap/session | jq .apiUrl

# Prod session via bridge (header opts in to the prod upstream)
curl -sS -H "X-Jmap-Bridge-Test-Upstream: prod" \
  -H "Authorization: Bearer $JMAP_ACCESS_TOKEN" \
  $BRIDGE/jmap/session | jq .apiUrl

# Preflight from the stage webmail origin (should 204 with CORS headers)
curl -i -X OPTIONS \
  -H "Origin: https://webmail.stage-thundermail.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Authorization, Content-Type" \
  $BRIDGE/jmap/

# Preflight from an unrecognised origin (should 403 with no CORS headers)
curl -i -X OPTIONS \
  -H "Origin: https://attacker.example" \
  -H "Access-Control-Request-Method: POST" \
  $BRIDGE/jmap/

# Stage WebSocket upgrade through the same Worker (HTTP/1.1 needed so
# Cloudflare doesn't strip the Upgrade header at the edge)
basic=$(printf 'user:pass' | base64 -w0)
wscat -c "$BRIDGE/jmap/ws?basic=$basic" -s jmap   # workers.dev test
wscat -c "wss://wsmail.stage-thundermail.com/jmap/ws?basic=$basic" -s jmap   # production
```

Expected: HTTP responses carry `apiUrl` and friends pointing at the
bridge host (`jmap.*`), not at `mail.*`. The WebSocket capability
URL points at `wsmail.*`. Preflights from allowlisted origins
return 204 with `Access-Control-Allow-Origin` echoing the request
origin and `Access-Control-Max-Age: 3600`; preflights from
unrecognised origins return 403 with no CORS headers (so the
browser blocks the request).

## Client wiring

`stormbox/src/defines.ts` is the single source of truth:

- `JMAP_SERVER_URL` resolves to `https://jmap.*.thundermail.com`
  for hosted SPA builds, so the transport hits the bridge.
- `JMAP_WS_PROXY_URL` resolves to `https://wsmail.*.thundermail.com/jmap/ws`,
  matching the bridge's WS half.

The transport reads `apiUrl`, `uploadUrl`, `downloadUrl`, and
`eventSourceUrl` out of the session document, so the rewritten
URLs flow through automatically after the first session fetch.
