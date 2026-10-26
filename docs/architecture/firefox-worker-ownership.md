# Firefox worker ownership

Gecko Firefox connections use `PRAGMA main.locking_mode = EXCLUSIVE` before
the first schema access. This keeps IDBBatchAtomicVFS from repeatedly acquiring
Web Locks, avoiding the Firefox worker callback-retention issue reproduced in
`research/firefox-web-locks/`. Chromium, Electron, Safari, and Firefox on iOS
keep the existing NORMAL mode. The VFS's separate `lockPolicy: 'exclusive'`
option remains unchanged. No on-disk schema or format change is required.

The connection also sets `PRAGMA main.journal_size_limit = 0`. Exclusive mode
retains the rollback journal after a page-cache spill. IDBBatchAtomicVFS cannot
safely overwrite its blocks across their original boundaries in a later
transaction. Truncating the completed journal prevents that reuse while preserving
journaled rollback and the lifetime database lock.

## Refresh and handoff

Firefox workers acquire one `stormbox.database-owner` Web Lock before opening
SQLite. They retain it until the worker exits, including if cleanup fails.
There is no forced release or lock stealing. Together with the retained VFS
lock, this bounds steady-state Web Lock requests instead of adding requests
per query.

The ownership control channel is available before database initialization.
Workers announce their script URL and creation time. A newer worker with a
different URL asks the older worker to retire; a worker already waiting behind
an even newer instance retires too. Equal timestamps use a random instance ID
as a tie-breaker. This orders worker instances rather than release versions,
so deliberately loading a rollback build also permits handoff.
That rollback must include this ownership protocol. A pre-protocol release
cannot ask an exclusive owner to retire; close all tabs before reverting to
such a release. Inconsistent assets across tabs can also cause repeated
handoffs, so deployment must serve a coherent release.

Retirement rejects new requests, waits for accepted work, stops sync, and closes
SQLite. Cleanup has a five-second deadline inside the worker. The retiring
worker broadcasts its URL and the replacement URL before closing; only its
clients reload. The replacement's clients continue waiting for actual lock
acquisition. A newly acquired owner also sends the legacy reload notification
for older releases that have no ownership protocol.

An ordinary deployment does not interrupt a running worker. Handoff starts
when a refresh or a new tab starts a different worker URL. As agreed for this
flow, other tabs reload without a separate draft-save negotiation.

## An unresponsive owner

The Firefox repository startup waits for the database to initialize, with a
15-second deadline in the tab. A frozen worker cannot disable that deadline.
Failure closes the tab's RPC connection and clears its cached startup promise,
so another connection attempt can succeed after ownership becomes available.
The restart notification channel stays open until a targeted retirement message
arrives or the page closes, allowing a superseded tab to reload after startup fails.
The deadline covers database initialization as well as ownership acquisition;
a very slow initialization can produce the same recovery message.

The existing LoginGate connection error and Try again control show the recovery
instructions: close all Stormbox tabs and windows, wait briefly, then reopen;
restart Firefox if access remains blocked. We do not claim that a timeout proves
a worker is dead or that closing tabs guarantees immediate browser reclamation.
Neither operation bypasses the database lock. The staff status display remains,
but the manual reset button is removed.
Try again reloads the entire app so failed store initialization runs again.
App-password mode uses the same recovery view when the database is unavailable.
App startup awaits settings/database attachment before starting OIDC. A failed
database connection therefore shows recovery without scheduling a login redirect.

## Validation

`tests/e2e/worker-handoff.spec.js` uses isolated browser contexts and real
SharedWorkers, SQLite, and IndexedDB. It checks lock-request counts, commit and
rollback, same-version sharing, cross-version handoff, legacy reload handling,
and an owner frozen with an unfinished transaction. The recovery state renders
the actual LoginGate component. Unit coverage exercises the browser policy,
startup deadline, notification targeting, and shutdown sequencing.

`tests/unit/db/engine-idb.test.js` compares both locking modes with the real
async SQLite build and IDBBatchAtomicVFS over fake-indexeddb. It checks large
commit/rollback, reopened data and integrity, persisted unfinished transactions,
SQLite I/O/full errors after partial writes, and the handoff cleanup deadline.
The shutdown model drains queued storage work before discarding the connection;
it tests persisted-checkpoint recovery, not browser termination during an active
IndexedDB transaction or physical durability. I/O/full errors are injected at the
VFS boundary, so these cases do not establish browser quota/abort handling.

References:

- https://www.sqlite.org/pragma.html#pragma_locking_mode
- https://www.sqlite.org/pragma.html#pragma_journal_size_limit
- https://www.w3.org/TR/web-locks/#termination
- https://github.com/rhashimoto/wa-sqlite/discussions/86
