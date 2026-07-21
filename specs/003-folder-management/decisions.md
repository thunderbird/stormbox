# Folder Review Decision Log

1. **`alreadyExists` membership — fixed.** Fetch `existingId`; verify and
   add missing destination memberships before success.
2. **Ambiguous cross-account copy — deferred.** Wait for Stalwart
   duplicate detection; tracked in Stormbox #88.
3. **JMAP limits/chunking — fixed.** Live Session limits and wire
   chunking stay entirely inside the JMAP backend; Core limits are not
   persisted.
4. **Query-change reconciliation — fixed.** Validate complete metadata,
   then atomically persist metadata, positions, totals, and query state.
5. **Push acknowledgement — fixed.** Persist `pushState` only after
   isolated account/type work succeeds; coalesce transient retries.
6. **Revoked shared accounts — fixed.** Session ingest transactionally
   removes absent non-primary cache scopes and conflicts their pending
   mutations.
7. **Confirmed copy reconciliation retry — deferred with #88.** Rely on
   the planned Stalwart `alreadyExists(existingId)` behavior rather
   than adding a separate checkpoint state machine.
8. **Post-copy folder counters — fixed.** Use a separate targeted
   `Mailbox/get` and persist counter-only updates before resolving.
9. **Partial move/delete UI finalization — fixed.** Finalize confirmed
   IDs through normal in-memory cleanup before reporting remaining
   failures.
10. **System folders as parents — fixed.** Protect the system folder
    itself while allowing children when `mayCreateChild` permits.
11. **Shared Not junk/Whitelist — disabled.** The combined action is
    available only in the primary account's Junk folder.
12. **Cross-account copy E2E — added.** Dedicated principals verify UI,
    source preservation, SQLite/JMAP destination state, counters, and
    cleanup on Chromium and Firefox.
