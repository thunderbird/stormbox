import {
  cleanupEmail,
  connectJmap,
  jmapRequest,
  listMailboxes,
  mailboxByRole,
  pickResponse,
} from './helpers/jmap-client.js';
import { FAULTS_PATH, STATUS_PATH, SUBMISSION_FAULTS } from '../fixtures/ws-proxy/inject.mjs';
import {
  attachConsoleTail,
  consoleLinesFor,
  expect,
  resetSharedSession,
  test,
} from './helpers/shared-session.js';
import {
  localStackEnabled,
  SHARED_TEST_OIDC_EMAIL,
  SHARED_TEST_OIDC_PASSWORD,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import {
  composeSendButton,
  composeSubject,
  fillRecipient,
  waitForIdentities,
} from './helpers/compose.js';

/**
 * An interrupted send must never deliver twice (CS-1.8, CS-1.9, CS-5.5).
 *
 * All three cases below leave the client in the same position — it issued
 * an `EmailSubmission/set` and never learned the outcome — and differ only
 * in what the server did. That is the whole difficulty of the problem, so
 * the fault is injected where the difference is real: the e2e WebSocket
 * proxy either forwards the submission and withholds its answer, or
 * answers without forwarding at all (see tests/fixtures/ws-proxy/inject.mjs).
 *
 *   LOSE  the server submitted; the response was lost. Positive
 *         reconciliation must find the evidence and finish the send.
 *   DROP  nothing was submitted, and the client cannot prove it. The row
 *         must park as outcome-unknown and stay there.
 *   HOLD  the server submitted and nothing ever answered the client.
 *         Recovery on the next start must not replay it.
 *
 * Each case first proves its fault fired, by reading the proxy's own
 * record of what it did. That check is not ceremony: one Email in Sent
 * and one delivery is also what an ordinary send produces, so without it
 * a case whose injection stopped matching would keep passing.
 *
 * Every case then asserts the same two things against the server:
 * exactly one Email carries the subject, and the recipient received at
 * most one copy. Delivery is proved against the second provisioned
 * account, because self-addressed delivery never arrives on the pinned
 * Stalwart v0.15.4 (issue #77).
 *
 * Most cases queue through the repository rather than the compose dialog,
 * because they are about what the outbox does with an ambiguous answer.
 * The last two drive the dialog itself, since the harm this work exists to
 * prevent is a user pressing Send twice: an outbox that parks correctly
 * while the composer still says "Send failed" and offers the button is the
 * defect, and only the UI leg can see that.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

const SUBJECT_PREFIX = 'Interrupted send e2e';

// The submission round trip is held open for up to the transport's WS
// deadline, and cross-account delivery takes a few seconds more, so these
// run well past the 30s budget the UI specs use.
test.setTimeout(240_000);

const WS_PROXY = process.env.WS_PROXY_URL ?? 'http://127.0.0.1:8787';

/**
 * Wait until the proxy reports it broke the submission of this exact
 * Email, and answer with what it did.
 *
 * Without this a case could pass on an entirely uninterrupted send: one
 * Email in Sent and one delivery is also what a working send produces, so
 * the assertions around it would be describing a fault that never fired —
 * because the marker stopped matching, or the transport fell back to HTTP,
 * or the proxy was running older code. The Email id is what makes it
 * specific: the log outlives the test, and both browser projects in a run
 * exercise the same three modes.
 */
async function faultApplied(mode, emailId) {
  expect(emailId, 'a fault can only be attributed to a known Email').toBeTruthy();
  const matches = async () => {
    const res = await fetch(`${WS_PROXY}${FAULTS_PATH}`, { signal: AbortSignal.timeout(5_000) });
    const applied = await res.json();
    return applied.filter((f) => f.mode === mode && f.emailId === emailId);
  };
  await expect.poll(async () => (await matches()).length, {
    timeout: 30_000,
    message: `the ws-proxy should have applied the ${mode} fault to ${emailId}`,
  }).toBe(1);
  return (await matches())[0];
}

/**
 * Wait until the client is actually talking to the proxy before a case
 * depends on a fault firing.
 *
 * Faults live in the WebSocket leg, and the transport uses HTTP whenever
 * its socket is not open — which is what a reload or a stopped account
 * leaves behind, and what the case before this one does deliberately. An
 * HTTP send never reaches the proxy, so the fault does not apply, the send
 * succeeds for real, and the case fails as though the client had ignored
 * an interrupted submission.
 */
async function waitForWebSocketLeg() {
  await expect.poll(
    async () => {
      const res = await fetch(`${WS_PROXY}${STATUS_PATH}`, { signal: AbortSignal.timeout(5_000) });
      // The proxy is a long-lived process this suite does not start, so it
      // can predate the endpoint. Saying so beats reporting a parse error.
      expect(
        res.ok,
        `the ws-proxy does not serve ${STATUS_PATH}; restart it with npm run stack:ws-proxy`,
      ).toBe(true);
      return (await res.json()).liveSockets;
    },
    {
      timeout: 60_000,
      message: 'the client should hold a WebSocket through the proxy before a fault is armed',
    },
  ).toBeGreaterThan(0);
}

/** Exact-subject lookup over the newest rows of a mailbox. */
async function findAllByExactSubject(jmap, mailbox, subject, limit = 30) {
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
  if (ids.length === 0) return [];
  const got = await jmapRequest(jmap, [[
    'Email/get',
    { accountId: jmap.accountId, ids, properties: ['subject'] },
    'g1',
  ]]);
  return (pickResponse(got, 'Email/get')?.list ?? [])
    .filter((m) => m.subject === subject)
    .map((m) => m.id);
}

/**
 * Queue a send without waiting for it. The insert notifies the runner on
 * its own, which is what lets a spec observe a row while its submission
 * is still open.
 */
async function queueSend(page, { to, subject }) {
  await waitForWebSocketLeg();
  return page.evaluate(async (payload) => {
    const repo = globalThis.__repo;
    const accounts = await repo.listAccounts();
    const accountId = accounts[0].id;
    const folders = await repo.listFolders(accountId);
    const byRole = (role) => folders.find((f) => f.role === role) ?? null;
    const identities = await repo.listIdentities(accountId);
    const mutation = await repo.insertPendingMutation({
      accountId,
      mutationType: 'send',
      targetMessageId: null,
      requestJson: JSON.stringify({
        identityId: identities[0].id,
        to: payload.to,
        cc: [],
        bcc: [],
        subject: payload.subject,
        textBody: 'Interrupted send e2e body.',
        htmlBody: '',
        draftsFolderId: byRole('drafts')?.id ?? null,
        sentFolderId: byRole('sent')?.id ?? null,
        outboxFolderId: null,
      }),
      optimisticPatchJson: null,
    });
    return { accountId, mutationId: mutation.id };
  }, { to, subject });
}

/** Queue a send and wait for the outbox to settle it. */
async function sendAndWait(page, { to, subject }) {
  const { accountId, mutationId } = await queueSend(page, { to, subject });
  const summary = await page.evaluate(
    async ({ id, account }) => globalThis.__repo.runMutation(account, id),
    { id: mutationId, account: accountId },
  );
  return { accountId, mutationId, summary };
}

/** Write a message in the dialog and press Send, without waiting for it. */
async function composeAndSend(page, { to, subject }) {
  await waitForWebSocketLeg();
  // The shortcut is a document-level handler, so it needs focus outside
  // whatever the previous case left it in.
  await page.locator('.folder-node').first().click();
  await page.keyboard.press('c');
  await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });
  await waitForIdentities(page);
  await fillRecipient(page, 'To', to);
  await composeSubject(page).fill(subject);
  const editor = page.locator('.compose-dialog .editor[contenteditable]').first();
  await editor.click();
  await page.keyboard.type('Interrupted send e2e body.');
  await composeSendButton(page).click();
}

/** The send row this subject produced, whether or not it survived. */
async function findSendMutation(page, subject) {
  const rows = await page.evaluate(async () => globalThis.__repo.call('db.query', {
    sql: `SELECT id, local_status, attempts, phase, error_json, server_response_json, request_json
            FROM pending_mutations WHERE mutation_type = 'send'`,
    params: [],
  }));
  return (rows ?? []).find((r) => JSON.parse(r.request_json ?? '{}').subject === subject) ?? null;
}

/**
 * The remote id of the Email a composed send created, once its checkpoint
 * records one. That id is what a fault can be attributed to, and it is
 * written before the submission the fault interferes with.
 */
async function waitForCreatedEmailId(page, subject) {
  let created = null;
  await expect.poll(
    async () => {
      const row = await findSendMutation(page, subject);
      created = JSON.parse(row?.server_response_json ?? '{}').emailRemoteId ?? null;
      return created;
    },
    { timeout: 60_000, message: 'the send should record the Email it created' },
  ).not.toBeNull();
  return created;
}

async function readMutation(page, mutationId) {
  return page.evaluate(async (id) => {
    const rows = await globalThis.__repo.call('db.query', {
      sql: `SELECT id, local_status, attempts, phase, error_json, server_response_json
              FROM pending_mutations WHERE id = ?`,
      params: [id],
    });
    return rows[0] ?? null;
  }, mutationId);
}

async function deleteMutation(page, mutationId) {
  await page.evaluate(async (id) => {
    await globalThis.__repo.call('db.query', {
      sql: 'DELETE FROM pending_mutations WHERE id = ?',
      params: [id],
    });
  }, mutationId).catch(() => {});
}

/**
 * Take the backend away from a send that is mid-submission, and bring a
 * fresh one back.
 *
 * A crash cannot be induced directly: neither Playwright nor CDP can kill
 * a SharedWorker in both browsers this lane runs. What is available is a
 * graceful stop, which is not the same thing — it aborts the transport, so
 * the submission call returns and the row is classified on the way down —
 * so the row is then put back to the state the stop took it out of.
 *
 * That reconstruction is only sound if it is reconstructing something
 * real, so both halves are pinned rather than assumed: the caller has
 * already watched the row reach `in_flight/submitting` on its own, and the
 * assertion below states what the orderly stop did to it. If shutdown ever
 * stops classifying the row, this fails and says so, rather than quietly
 * overwriting a state that no longer needs overwriting.
 *
 * What is not reconstructed at all is the server's side: the submission
 * really was forwarded and really was answered to nobody, which the
 * proxy's own fault log proves before this is called.
 */
async function killWorkerAndReload(page, mutationId) {
  await page.evaluate(async () => {
    const accounts = await globalThis.__repo.listAccounts();
    if (accounts[0]?.id != null) {
      await globalThis.__repo.stopSyncAccount(accounts[0].id);
    }
  });

  const afterStop = await readMutation(page, mutationId);
  expect(
    `${afterStop?.local_status}/${afterStop?.phase}`,
    'an orderly stop parks the row itself, which is what has to be undone here',
  ).toBe('conflicted/unknown');

  await page.evaluate(async (id) => {
    // What a crash leaves instead: the last phase written before the call,
    // and a row still checked out to a worker that no longer exists.
    await globalThis.__repo.call('db.query', {
      sql: `UPDATE pending_mutations
               SET local_status = 'in_flight',
                   phase = 'submitting',
                   error_json = NULL
             WHERE id = ?`,
      params: [id],
    });
  }, mutationId);

  await page.reload();
  await expect(page.locator('.folder-node').first()).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => !!window.__repo, { timeout: 30_000 });
}

test.describe('Interrupted send', () => {
  let jmap;
  let recipient;
  let mailboxes;
  let sent;
  let drafts;
  let trash;
  let recipientInbox;
  let recipientTrash;

  test.beforeAll(async () => {
    jmap = await connectJmap();
    recipient = await connectJmap({
      username: SHARED_TEST_OIDC_EMAIL,
      password: SHARED_TEST_OIDC_PASSWORD,
    });
    mailboxes = await listMailboxes(jmap);
    sent = mailboxByRole(mailboxes, 'sent');
    drafts = mailboxByRole(mailboxes, 'drafts');
    trash = mailboxByRole(mailboxes, 'trash');
    const recipientMailboxes = await listMailboxes(recipient);
    recipientInbox = mailboxByRole(recipientMailboxes, 'inbox');
    recipientTrash = mailboxByRole(recipientMailboxes, 'trash');
    if (!sent || !drafts || !trash || !recipientInbox || !recipientTrash) {
      throw new Error('Test requires Sent, Drafts and Trash on both accounts');
    }
  });

  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage, {
      extraSubjectPrefixes: [SUBJECT_PREFIX],
    });
  });

  /** Trash every copy the case produced, on both accounts. */
  async function sweep(subject) {
    for (const mailbox of [sent, drafts, mailboxByRole(mailboxes, 'inbox')]) {
      if (!mailbox) continue;
      for (const id of await findAllByExactSubject(jmap, mailbox, subject).catch(() => [])) {
        await cleanupEmail(jmap, id, trash.id).catch(() => {});
      }
    }
    for (const id of await findAllByExactSubject(recipient, recipientInbox, subject).catch(() => [])) {
      await cleanupEmail(recipient, id, recipientTrash.id).catch(() => {});
    }
  }

  test('resolves a lost submission response into a completed send', async ({ sharedPage: page }, testInfo) => {
    // The server accepted the submission; only the answer went missing.
    // Positive reconciliation has the evidence to finish this, and must
    // use it: reporting a failure here is what makes a user press Send
    // again on a message that is already in transit.
    const subject = `${SUBJECT_PREFIX} lost ${Date.now()} ${SUBMISSION_FAULTS.LOSE}`;
    let mutationId = null;
    try {
      const result = await sendAndWait(page, {
        to: [{ email: SHARED_TEST_OIDC_EMAIL }],
        subject,
      });
      mutationId = result.mutationId;

      expect(
        result.summary.failed,
        'a submission the server accepted must not be reported as a failed send',
      ).toBe(0);
      expect(await readMutation(page, mutationId), 'a completed send retires its row').toBeNull();

      // One Email, in Sent, and one delivery.
      await expect.poll(
        async () => (await findAllByExactSubject(jmap, sent, subject)).length,
        { timeout: 60_000, message: 'the reconciled send should be in Sent' },
      ).toBe(1);
      const [filedId] = await findAllByExactSubject(jmap, sent, subject);
      expect(
        await findAllByExactSubject(jmap, drafts, subject),
        'no orphan draft may be left behind',
      ).toEqual([]);

      // And the send that produced it really was interrupted: the proxy
      // forwarded this Email's submission and blanked the answer.
      const fault = await faultApplied('LOSE', filedId);
      expect(fault.effect).toBe('responseBlanked');
      await expect.poll(
        async () => (await findAllByExactSubject(recipient, recipientInbox, subject)).length,
        { timeout: 90_000, message: 'the recipient should receive exactly one copy' },
      ).toBe(1);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      if (mutationId != null) await deleteMutation(page, mutationId);
      await sweep(subject);
    }
  });

  test('parks a genuinely ambiguous submission and never retries it', async ({ sharedPage: page }, testInfo) => {
    // Nothing was submitted, and the client cannot prove it. Guessing
    // either way is a defect: guessing success loses the message,
    // guessing failure and retrying delivers twice if the guess is wrong.
    const subject = `${SUBJECT_PREFIX} ambiguous ${Date.now()} ${SUBMISSION_FAULTS.DROP}`;
    let mutationId = null;
    try {
      const result = await sendAndWait(page, {
        to: [{ email: SHARED_TEST_OIDC_EMAIL }],
        subject,
      });
      mutationId = result.mutationId;
      expect(result.summary.failed, 'an unprovable outcome must not report success').toBe(1);

      const row = await readMutation(page, mutationId);
      expect(row, 'the row survives so the message is not lost').not.toBeNull();
      expect(row.local_status).toBe('conflicted');
      // The checkpoint names the Email whose submission the proxy
      // swallowed, which is what proves this row was interrupted rather
      // than refused for some ordinary reason.
      const created = JSON.parse(row.server_response_json ?? '{}').emailRemoteId;
      const fault = await faultApplied('DROP', created);
      expect(fault.effect, 'the submission must never have reached the server').toBe('notForwarded');
      expect(row.phase, 'the durable state records that the outcome is unknown').toBe('unknown');
      const error = JSON.parse(row.error_json ?? '{}');
      // One type classifies every parked send, wherever it was parked
      // from; whatever the transport managed to say is kept as the
      // diagnostic, being all that is left of a response nobody saw.
      expect(error.type).toBe('outcomeUnknown');
      expect(error.reason, 'the diagnostic survives').toBeTruthy();
      expect(error.terminal, 'an unknown outcome must not be retried automatically').toBe(true);

      // The draft the create left behind is the only copy on the server.
      await expect.poll(
        async () => (await findAllByExactSubject(jmap, drafts, subject)).length,
        { timeout: 30_000, message: 'the created draft should still be in Drafts' },
      ).toBe(1);
      expect(
        await findAllByExactSubject(jmap, sent, subject),
        'nothing may be filed in Sent for a send that was never confirmed',
      ).toEqual([]);

      // Asking again must not become a second attempt. The proxy breaks
      // one submission only, so a retry here would reach the server and
      // deliver — which is exactly what the assertions below would see.
      const retry = await page.evaluate(
        async ({ id, account }) => globalThis.__repo.runMutation(account, id),
        { id: mutationId, account: result.accountId },
      );
      expect(retry.failed, 'a parked send stays parked').toBe(1);
      const afterRetry = await readMutation(page, mutationId);
      expect(afterRetry.phase).toBe('unknown');
      expect(
        (await findAllByExactSubject(jmap, drafts, subject)).length,
        'a second attempt would have created a second draft',
      ).toBe(1);
      expect(
        await findAllByExactSubject(jmap, sent, subject),
        'a second attempt would have filed a copy in Sent',
      ).toEqual([]);
      expect(
        await findAllByExactSubject(recipient, recipientInbox, subject),
        'nothing was submitted, so nothing may be delivered',
      ).toEqual([]);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      if (mutationId != null) await deleteMutation(page, mutationId);
      await sweep(subject);
    }
  });

  test('does not replay a send left stranded with its submission accepted', async ({ sharedPage: page }, testInfo) => {
    // The riskiest window there is: the server has the submission, the
    // client has nothing, and the row comes back to a fresh worker that
    // has to decide what to do with it. It must decide "not this one".
    const subject = `${SUBJECT_PREFIX} killed ${Date.now()} ${SUBMISSION_FAULTS.HOLD}`;
    let mutationId = null;
    try {
      const queued = await queueSend(page, {
        to: [{ email: SHARED_TEST_OIDC_EMAIL }],
        subject,
      });
      mutationId = queued.mutationId;

      await expect.poll(
        async () => {
          const row = await readMutation(page, mutationId);
          return row ? `${row.local_status}/${row.phase}` : 'gone';
        },
        {
          // Inside the transport's own 30s WebSocket deadline, after which
          // the row would leave in_flight on its own.
          timeout: 20_000,
          message: 'the send should reach its submission phase and stay there',
        },
      ).toBe('in_flight/submitting');

      // The submission is genuinely out and unanswerable, which is the
      // half of a dead worker that cannot be reconstructed: the server has
      // the message and the client will never hear about it.
      const open = await readMutation(page, mutationId);
      const created = JSON.parse(open.server_response_json ?? '{}').emailRemoteId;
      const fault = await faultApplied('HOLD', created);
      expect(fault.effect).toBe('responseWithheld');

      await killWorkerAndReload(page, mutationId);

      // Recovery classified it rather than replaying it.
      await expect.poll(
        async () => (await readMutation(page, mutationId))?.local_status ?? 'gone',
        { timeout: 60_000, message: 'stranded-row recovery should have run on the new backend' },
      ).toBe('conflicted');
      const row = await readMutation(page, mutationId);
      const error = JSON.parse(row.error_json ?? '{}');
      expect(error.type).toBe('outcomeUnknown');
      expect(error.reason).toBe('interrupted');
      expect(
        row.phase,
        'recovery classifies the row without erasing how far the send got',
      ).toBe('submitting');

      // The server's side of the same story: it did submit, exactly once.
      await expect.poll(
        async () => (await findAllByExactSubject(recipient, recipientInbox, subject)).length,
        { timeout: 90_000, message: 'the held submission was forwarded, so one copy should arrive' },
      ).toBe(1);
      const copies = [
        ...await findAllByExactSubject(jmap, sent, subject),
        ...await findAllByExactSubject(jmap, drafts, subject),
      ];
      expect(copies, 'the interrupted send may leave exactly one Email behind').toHaveLength(1);

      // And nothing since the restart has produced a second one.
      await page.waitForTimeout(5_000);
      expect(
        (await findAllByExactSubject(recipient, recipientInbox, subject)).length,
        'a replayed submission would deliver a second copy',
      ).toBe(1);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      if (mutationId != null) await deleteMutation(page, mutationId);
      await sweep(subject);
    }
  });

  test('resolves an unconfirmed send through the mailbox, not a composer state', async ({ sharedPage: page }, testInfo) => {
    // The outbox parking the row is only half the protection: the row is
    // never resubmitted, so a second delivery cannot happen by itself.
    // For the user, the created Email is on the server — in Drafts, since
    // the submission never went out — so the composer closes and points
    // at the folders instead of trapping the draft behind a state whose
    // only exit was Discard (CS-1.9).
    const subject = `${SUBJECT_PREFIX} ui unknown ${Date.now()} ${SUBMISSION_FAULTS.DROP}`;
    let mutationId = null;
    try {
      await composeAndSend(page, { to: SHARED_TEST_OIDC_EMAIL, subject });
      const toast = page.locator('.store-error-toast__item--success')
        .filter({ hasText: /could not confirm/i });
      const toastText = toast.waitFor({ state: 'visible', timeout: 90_000 })
        .then(() => toast.textContent());

      // Verify the injected fault before interpreting the captured notice:
      // an uninterrupted send produces an ordinary success.
      const created = await waitForCreatedEmailId(page, subject);
      const fault = await faultApplied('DROP', created);
      expect(fault.effect, 'the submission must never have reached the server')
        .toBe('notForwarded');

      // The composer closes: the draft is not lost with it, because the
      // created Email is already sitting in Drafts on the server.
      await expect(page.locator('.compose-dialog')).toBeHidden({ timeout: 90_000 });
      const notice = await toastText;
      expect(notice).toMatch(/could not confirm/i);
      expect(notice).toMatch(/Sent/);
      expect(notice).toMatch(/Drafts/);

      // The same row the programmatic case asserts, reached through the UI.
      const row = await findSendMutation(page, subject);
      expect(row, 'the row survives as the durable no-retry record').not.toBeNull();
      mutationId = row.id;
      expect(row.local_status).toBe('conflicted');
      expect(JSON.parse(row.error_json ?? '{}').type).toBe('outcomeUnknown');
      expect(
        await findAllByExactSubject(recipient, recipientInbox, subject),
        'nothing was submitted, so nothing may be delivered',
      ).toEqual([]);
      // Where the user is told to look: the message is findable in Drafts.
      expect(
        await findAllByExactSubject(jmap, drafts, subject),
        'the unconfirmed message waits in Drafts for the user to resolve',
      ).toHaveLength(1);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      if (mutationId != null) await deleteMutation(page, mutationId);
      await sweep(subject);
    }
  });

  test('confirms a send through the composer once reconciliation resolves it', async ({ sharedPage: page }, testInfo) => {
    // The other half: a send whose response was lost is still a send, and
    // the composer has to say so rather than leaving the user guessing.
    const subject = `${SUBJECT_PREFIX} ui lost ${Date.now()} ${SUBMISSION_FAULTS.LOSE}`;
    try {
      await composeAndSend(page, { to: SHARED_TEST_OIDC_EMAIL, subject });

      await expect(page.locator('.compose-dialog')).toBeHidden({ timeout: 90_000 });
      await expect(
        page.locator('.store-error-toast__item--success')
          .filter({ hasText: /accepted for delivery/i }),
      ).toBeVisible({ timeout: 30_000 });
      expect(
        await findSendMutation(page, subject),
        'a completed send retires its row',
      ).toBeNull();

      await expect.poll(
        async () => (await findAllByExactSubject(jmap, sent, subject)).length,
        { timeout: 60_000, message: 'the reconciled send should be in Sent' },
      ).toBe(1);
      const [filedId] = await findAllByExactSubject(jmap, sent, subject);
      const fault = await faultApplied('LOSE', filedId);
      expect(fault.effect).toBe('responseBlanked');
      await expect.poll(
        async () => (await findAllByExactSubject(recipient, recipientInbox, subject)).length,
        { timeout: 90_000, message: 'the recipient should receive exactly one copy' },
      ).toBe(1);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await sweep(subject);
    }
  });
});
