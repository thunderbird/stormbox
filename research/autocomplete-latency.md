# Recipient autocomplete latency

The recipient input imposed a 120 ms trailing debounce before the contacts
store could issue its local SQLite RPC. CS-3.14 measured only query execution,
so its 50 ms worker budget did not bound the delay a person saw while typing.

## Implementation

- Use the existing scheduler with a zero-delay default. This combines inputs
  in the same event-loop turn without waiting for a pause in typing.
- Invalidate outstanding answers when new input is scheduled, rather than
  waiting until the next query begins. Explicit lookups cancel scheduled
  duplicates; disposal invalidates pending answers.
- Preserve worker-owned matching, ranking, exclusions, and the ten-result cap.
- Test the production default, response ordering, dismissal, and disposal.
  Measure browser input to matching DOM and the following paint opportunity
  with the real repository, rather than timing Playwright's polling.

## References reviewed

- [RAIL response guidance](https://web.dev/articles/rail) places immediate
  feedback within 100 ms. A fixed 120 ms delay already exceeds that budget.
- [Thunderbird compose inputs](https://github.com/mozilla/releases-comm-central/blob/master/mail/components/compose/content/messengercompose.xhtml)
  specify a 200 ms autocomplete timeout and multiple sources, including LDAP.
  That delay is not suitable for Stormbox's local-only lookup target.
- [Nextcloud composer](https://github.com/nextcloud/mail/blob/main/src/components/Composer.vue)
  uses a 500 ms promise debounce; its
  [autocomplete service](https://github.com/nextcloud/mail/blob/main/src/service/AutocompleteService.js)
  performs an HTTP request. Stormbox has no network request to throttle here.
- [Thunderbird bug 984875](https://bugzilla.mozilla.org/show_bug.cgi?id=984875)
  documents large-address-book single-character search stalls. Keep the
  existing worker-side indexed queries and 5,000-contact performance tests;
  do not copy the address book into the UI to remove the scheduling delay.
- [VueUse useDebounceFn](https://vueuse.org/shared/usedebouncefn/) was reviewed
  as an already-installed scheduling option. The existing scheduler already
  supports the required coalescing and cancellation, so no new abstraction
  or dependency is needed.

## Measurement (2026-10-22)

After the test account's initial mail indexing completed, 20 input samples
per browser measured the real input, repository RPC, DOM update, and a paint
opportunity. Ten samples searched one character; ten searched longer prefixes.
The test also checked the final result of typing at 20 ms per character; that
sequence is a behavior check, not a separate latency measurement.

| Browser | Input-to-frame p95 |
| --- | ---: |
| Chromium | 33.6 ms |
| Firefox | 33.0 ms |

The old 120 ms debounce alone exceeds the 100 ms browser budget. Initial
measurements made during mail indexing also saw delays above one second;
those are shared-worker contention, not eliminated by changing the input
scheduler. These numbers describe a ready cache, not startup performance or
a guarantee for every machine.

Validation: 158 focused unit tests, including the 5,000-contact performance
suite (worst-case substring p95 7.5 ms), typechecking, and ESLint on the changed
TypeScript/Vue files passed. All 16 browser checks passed, including the two
authentication setup checks. The browser check lives in
`tests/e2e/compose-recipient-control.spec.js` and runs with the existing
keyboard, paste, selection, and accessibility cases:

```sh
docker exec -w /workspace -e INCLUDE_CHROMIUM=1 thundermail-dev \
  npm run test:e2e:local -- tests/e2e/compose-recipient-control.spec.js \
  --project=chromium --project=firefox --retries=0
```

An independent read-only review found no blocking issues. Its missing
single-character coverage finding was addressed before the measured run.
