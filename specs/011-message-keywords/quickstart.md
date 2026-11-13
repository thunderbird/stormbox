# Quickstart: Tag Views Include Archive and Exclude Junk

**Feature**: MK-3.4 amendment for issue #237
**Date**: 2026-11-13

This guide describes how to validate the change end to end. It is a
validation guide, not an implementation or test-suite reference.

## Prerequisites

- The `stormbox-compose` dev container is running.
- For live E2E, the local stack is configured and the WS proxy is
  running inside the container:

  ```bash
  docker exec -d stormbox-compose bash -c \
    'cd /workspace && npm run stack:ws-proxy > /tmp/ws-proxy.log 2>&1'
  ```

- The branch contains the MK-3.4 amendment and the predicate change.
- All commands run inside the container, never on the host.

## Automated validation

### 1. Unit tests for the cache query

```bash
docker exec stormbox-compose bash -c \
  'cd /workspace && npx vitest run tests/unit/db/handlers.test.ts'
```

Expected:

- `message.listForKeyword` and `message.countForKeyword` include a
  message filed only in Archive.
- They exclude a message filed only in Trash.
- They exclude a message filed only in Junk.
- They exclude a message filed in Inbox and Junk.
- They include a message filed in Inbox and Archive.
- `message.listKeywords({ forTagView: true })` counts match the rows.

### 2. Unit tests for the store

```bash
docker exec stormbox-compose bash -c \
  'cd /workspace && npx vitest run tests/unit/stores/mail-store.test.ts'
```

Expected: the “tag views (MK-3.4)” cases still pass, including synthetic
folder ids, loading, broadcast reload, counts, coverage, and selection.

### 3. Type checking

```bash
docker exec stormbox-compose bash -c 'cd /workspace && npm run typecheck'
```

Expected: no errors.

### 4. Browser E2E

```bash
docker exec stormbox-compose bash -c \
  'cd /workspace && npm run test:e2e:local -- \
    tests/e2e/tag-view.spec.js \
    --project=chromium --project=firefox'
```

Expected:

- A tagged message in Archive appears in its tag view.
- A tagged message in Trash does not appear.
- A tagged message in Junk does not appear.
- A tagged message in Inbox and Archive appears.
- A tagged message in Inbox and Junk does not appear.
- The same results hold for the `Starred` view using `$flagged`.
- The sidebar tag count equals the number of rows in the cached query.
- The existing select-all, tag removal, and filing scenarios still pass.

## Manual validation

Use the local stack and sign in as `admin@example.org` / `admin`.

1. Pick a message in Inbox and apply a tag, for example `Personal`.
2. Archive the message.
3. Open the `Personal` tag from the sidebar.
   - Expected: the archived message is listed.
   - Expected: the sidebar count includes it.
4. Mark another tagged message as junk from Inbox.
5. Open the tag view again.
   - Expected: the junk message is not listed.
   - Expected: the sidebar count does not include it.
6. Delete another tagged message to Trash.
7. Open the tag view again.
   - Expected: the trashed message is not listed.
8. Star an archived message and open `Starred`.
   - Expected: the archived starred message is listed.

## Regression checks

- The tag manager's “keywords on your messages” list still discovers
  keywords from all folders, including Trash and Junk. That path does not
  use `forTagView`.
- The open tag view still keeps its header, toolbar, selection model,
  and 2000-row cap.
- Dragging or generic moving from a tag view is still refused; the
  existing MK-3.4 rules are unchanged.

## Out of scope

Do not expect or assert these in this change:

- A message in a child of Trash or Junk being excluded. Child folders do
  not inherit roles; that is a separate decision.
- Per-folder union semantics for multi-membership messages. A Junk
  membership hides the message even if it is also in Inbox.
- Any JMAP query, schema migration, or outbox mutation.
