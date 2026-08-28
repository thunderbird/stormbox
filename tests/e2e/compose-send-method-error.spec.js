import {
  cleanupEmail,
  connectJmap,
  jmapRequest,
  listMailboxes,
  mailboxByRole,
  pickResponse,
} from './helpers/jmap-client.js';
import { INJECT_MARKER, INJECTED_ERROR_TYPE } from '../fixtures/ws-proxy/inject.mjs';
import {
  attachConsoleTail,
  consoleLinesFor,
  expect,
  resetSharedSession,
  test,
} from './helpers/shared-session.js';
import {
  localStackEnabled,
  selfEmail,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import { clickFolder } from './helpers/ui.js';
import {
  composeSubject,
  discardCompose,
  fillRecipient,
  recipientAddresses,
  waitForIdentities,
} from './helpers/compose.js';

/**
 * A method-level JMAP failure must fail the send (CS-1.3), keep the
 * mutation row that holds the only durable copy of the message, and
 * leave Sent untouched in both the local cache and on the server
 * (CS-1.4).
 *
 * The error is injected by the e2e WebSocket proxy, which answers a
 * request carrying INJECT_MARKER with an `error` response slot instead of
 * forwarding it (see tests/fixtures/ws-proxy/inject.mjs for why that has
 * to happen in the proxy). The marker rides in the subject, so it reaches
 * the proxy inside the send's `Email/set` create and nothing else in the
 * run is affected.
 *
 * Because the proxy never forwards that request, the server performs no
 * operation at all — which is what separates an injected method-level
 * error from a rewritten response, and is why the spec can assert the
 * message is absent from every mailbox rather than just from Sent.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

/**
 * Exact-subject lookup over the newest rows of a mailbox. The JMAP
 * `subject` filter is full-text tokenised, so a subject carrying the
 * hyphenated marker cannot be matched by filtering server-side.
 */
async function findByExactSubject(jmap, mailbox, subject, limit = 30) {
  const query = await jmapRequest(jmap, [[
    'Email/query',
    {
      accountId: jmap.accountId,
      filter: { inMailbox: mailbox.id },
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit,
    },
    'q1',
  ]]);
  const ids = pickResponse(query, 'Email/query')?.ids ?? [];
  if (ids.length === 0) return null;
  const got = await jmapRequest(jmap, [[
    'Email/get',
    { accountId: jmap.accountId, ids, properties: ['subject'] },
    'g1',
  ]]);
  const match = (pickResponse(got, 'Email/get')?.list ?? [])
    .find((m) => m.subject === subject);
  return match?.id ?? null;
}

async function readSendMutations(page) {
  return page.evaluate(async () => {
    if (!globalThis.__repo) return [];
    return globalThis.__repo.call('db.query', {
      sql: `SELECT id, local_status, request_json, error_json, phase
              FROM pending_mutations
             WHERE mutation_type = 'send'
             ORDER BY created_at DESC
             LIMIT 5`,
      params: [],
    });
  });
}

/**
 * The newest subjects in the local Sent view. Sent is newest-first and a
 * filed send is prepended at position 0, so the head of the list is
 * where an unwanted addition would show up.
 */
async function readSentSubjects(page) {
  return page.evaluate(async () => {
    if (!globalThis.__repo) return null;
    const accounts = await globalThis.__repo.listAccounts();
    const accountId = accounts?.[0]?.id;
    if (accountId == null) return null;
    const folders = await globalThis.__repo.listFolders(accountId);
    const sent = folders.find((f) => f.role === 'sent');
    if (!sent) return null;
    const rows = await globalThis.__repo.listMessagesForView({
      accountId, folderId: sent.id, sort: 'sent', offset: 0, limit: 50,
    });
    return rows.map((r) => r.subject ?? '');
  });
}

/**
 * The Sent subjects, read once the view has stopped filling.
 *
 * `clickFolder` returns when the folder is selected, and the query view
 * hydrates behind it. A baseline taken mid-hydration is short, so every row
 * that lands afterwards looks like something this test's send filed: the
 * assertion below then reports the whole contents of Sent as additions,
 * none of them this test's message. Correct product behaviour, failing test.
 */
async function readSettledSentSubjects(page) {
  let previous = null;
  let settled = null;
  await expect.poll(
    async () => {
      const current = await readSentSubjects(page);
      const stable = current !== null && previous !== null
        && current.length === previous.length
        && current.every((subject, idx) => subject === previous[idx]);
      previous = current;
      if (stable) settled = current;
      return stable;
    },
    {
      timeout: 20_000,
      intervals: [250, 250, 500, 500, 1_000],
      message: 'the Sent view should finish loading before it is used as a baseline',
    },
  ).toBe(true);
  return settled;
}

function countBySubject(subjects) {
  const counts = new Map();
  for (const subject of subjects) {
    counts.set(subject, (counts.get(subject) ?? 0) + 1);
  }
  return counts;
}

/**
 * Subjects the Sent view gained, counting duplicates, so a second copy
 * of a subject that was already there is reported too.
 *
 * Only additions are a defect. Sent can legitimately *lose* rows during
 * the test: earlier specs in this worker's shared session move their
 * sent messages to Trash on the way out, and the resulting StateChange
 * can arrive over the push channel at any point, including between the
 * before and after reads.
 */
function subjectsAddedTo(before, after) {
  const beforeCounts = countBySubject(before);
  const added = [];
  for (const [subject, count] of countBySubject(after)) {
    const gained = count - (beforeCounts.get(subject) ?? 0);
    for (let i = 0; i < gained; i += 1) added.push(subject);
  }
  return added;
}

test.describe('Compose send: method-level JMAP error', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage, {
      extraSubjectPrefixes: ['Method error e2e'],
    });
  });

  test('reports failure, keeps the mutation row, and files nothing in Sent', async ({ sharedPage: page }, testInfo) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const sent = mailboxByRole(mailboxes, 'sent');
    const drafts = mailboxByRole(mailboxes, 'drafts');
    const trash = mailboxByRole(mailboxes, 'trash');
    if (!sent || !trash) {
      throw new Error('Test requires Sent and Trash mailboxes');
    }

    // The marker has to survive into the Email/set create, so it lives
    // in the subject rather than in a header the client rewrites.
    const subject = `Method error e2e ${Date.now()} ${INJECT_MARKER}`;
    let strayId = null;
    let mutationId = null;
    try {
      // Warm Sent so a mailbox-window query_view exists. Without one,
      // "nothing was added to Sent" would be true for the uninteresting
      // reason that there was no view to add to.
      await clickFolder(page, sent.name);
      const sentBefore = await readSettledSentSubjects(page);
      expect(sentBefore, 'Sent view should be readable before the send').not.toBeNull();
      await clickFolder(page, 'Inbox');

      await page.keyboard.press('ControlOrMeta+n');
      await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });
      await waitForIdentities(page);

      await fillRecipient(page, 'To', selfEmail());
      await composeSubject(page).fill(subject);
      const editor = page.locator('.compose-dialog .editor[contenteditable]').first();
      await editor.click();
      await page.keyboard.type('This send is answered with a method-level error.');

      await page.locator('.compose-dialog button.primary', { hasText: /^Send$/ }).click();

      // The composer reports the failure and keeps the draft. A silent
      // success here is the CS-1.3 defect: the row that holds the only
      // copy of the message would already have been deleted.
      const error = page.locator('.compose-dialog .compose-error');
      await expect(error).toBeVisible({ timeout: 60_000 });
      await expect(error).toHaveText(/Send failed/i);
      await expect(composeSubject(page)).toHaveValue(subject);
      expect(await recipientAddresses(page, 'To')).toEqual([selfEmail().toLowerCase()]);

      // The mutation row survives, carrying the server's own reason.
      const rows = await readSendMutations(page);
      const row = rows.find((r) => JSON.parse(r.request_json ?? '{}').subject === subject);
      expect(row, 'the send mutation row must survive the failure').toBeTruthy();
      mutationId = row.id;
      expect(row.local_status).toBe('conflicted');
      const rowError = JSON.parse(row.error_json ?? '{}');
      expect(
        rowError.type,
        'the injected method-level error should be the recorded reason; a different '
        + 'type means the proxy never saw the request, most likely because the '
        + 'transport fell back to HTTP',
      ).toBe(INJECTED_ERROR_TYPE);
      expect(rowError.terminal, 'a request-shaped rejection must not be retried').toBe(true);

      // Local cache: nothing was filed into Sent.
      const sentAfter = await readSentSubjects(page);
      expect(sentAfter).not.toContain(subject);
      expect(
        subjectsAddedTo(sentBefore, sentAfter),
        'a failed send must add nothing to the local Sent view',
      ).toEqual([]);

      // Server: the operation never happened, so the message is in no
      // mailbox at all — not Sent, and not left behind in Drafts.
      expect(await findByExactSubject(jmap, sent, subject)).toBeNull();
      if (drafts) {
        expect(await findByExactSubject(jmap, drafts, subject)).toBeNull();
      }
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      // Retire the conflicted row so later specs in this worker's shared
      // session do not inherit a failed send.
      if (mutationId != null) {
        await page.evaluate(async (id) => {
          await globalThis.__repo.call('db.query', {
            sql: 'DELETE FROM pending_mutations WHERE id = ?',
            params: [id],
          });
        }, mutationId).catch(() => {});
      }
      await discardCompose(page).catch(() => {});
      // Defensive: if the injection did not take effect the send
      // succeeded, and the message must not be left on the server.
      strayId = await findByExactSubject(jmap, sent, subject).catch(() => null);
      if (strayId) {
        await cleanupEmail(jmap, strayId, trash.id).catch(() => {});
      }
    }
  });
});
