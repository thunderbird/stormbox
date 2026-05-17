# Stalwart e2e fixture

A self-contained Stalwart Mail Server (`stalwartlabs/stalwart:v0.16`)
used by the Stormbox end-to-end tests. v0.16 is the first Stalwart
release that supports JMAP-Contacts (RFC 9610), which Stormbox needs.

## Bring it up

From inside the dev container (or any host with Docker):

```bash
cd tests/fixtures/stalwart
docker compose up -d
bash seed.sh    # waits for /.well-known/jmap to come online
```

Stalwart starts in "recovery" mode with the credentials baked into
`docker-compose.yml`:

| Username | Password         | Notes                       |
|----------|------------------|-----------------------------|
| admin    | admin-pass-test  | Recovery admin; full access |

The recovery admin is provisioned by Stalwart itself when the
`STALWART_RECOVERY_ADMIN` env var is set, so no separate seeding step
is needed.

## Run the live e2e test

```bash
STALWART_HOST=http://localhost:18080 npx playwright test
```

Without `STALWART_HOST` the live test skips cleanly and only the smoke
test runs.

## Tear it down

```bash
docker compose down -v
```

The `-v` removes the rocksdb volume so the next bring-up starts fresh.

## Removing the file is fine

This fixture is for local development and CI only. Do not deploy it
anywhere with real mail; there is no TLS, no spam filtering, and the
admin password is checked into the repository.

## Adding a regular (non-admin) user

If a test needs to exercise a non-admin flow, log in to the Stalwart
admin web UI at `http://localhost:18080/admin` with the recovery
credentials and create a principal there, or use Stalwart's CLI:

```bash
docker exec -it stormbox-stalwart stalwart-cli account create \
  tester tester-pass-test --email tester@stormbox.test
```
