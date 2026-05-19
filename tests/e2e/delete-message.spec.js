import { test, expect } from '@playwright/test';

const STAGE_USERNAME = process.env.STAGE_USERNAME;
const STAGE_PASSWORD = process.env.STAGE_PASSWORD;
const STAGE_SELF_EMAIL = process.env.STAGE_SELF_EMAIL;
const JMAP_BASE_URL = process.env.STAGE_JMAP_URL ?? 'https://mail.stage-thundermail.com';

test.skip(
  !STAGE_USERNAME || !STAGE_PASSWORD,
  'STAGE_USERNAME / STAGE_PASSWORD not set; live-stage delete e2e skipped',
);

test.describe('Delete message e2e', () => {
  test.setTimeout(180_000);

  // Sweep any orphan test messages from prior interrupted runs out of
  // the way before each test. Ctrl+C during a previous run can skip
  // the per-test finally block; without this, those orphans accumulate
  // in the live account forever and the user has to clean them up.
  test.beforeEach(async () => {
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap);
  });

  test('delete moves a real server-side draft to Trash', async ({ page }, testInfo) => {
    const consoleLines = [];
    page.on('console', (msg) => {
      consoleLines.push(`[${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      consoleLines.push(`[pageerror] ${err.message}`);
    });

    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const drafts = mailboxByRole(mailboxes, 'drafts');
    const trash = mailboxByRole(mailboxes, 'trash');
    if (!drafts || !trash) {
      throw new Error(`Test requires Drafts and Trash mailboxes; saw ${mailboxes.map((m) => `${m.name}:${m.role}`).join(', ')}`);
    }

    const selfEmail = STAGE_SELF_EMAIL
      || (STAGE_USERNAME.includes('@') ? STAGE_USERNAME : null);
    if (!selfEmail) {
      throw new Error('Set STAGE_SELF_EMAIL to a full address for this account.');
    }

    const subject = `Delete e2e ${Date.now()}`;
    let createdId = null;
    try {
      createdId = await createDraft(jmap, {
        draftsId: drafts.id,
        fromEmail: selfEmail,
        subject,
      });

      await expect.poll(
        async () => classifyMailboxState(await getEmailMailboxIds(jmap, createdId), { source: drafts, trash }),
        { timeout: 30_000, message: 'created test message should start in Drafts' },
      ).toBe('source');

      await login(page);
      await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });

      await clickFolder(page, drafts.name);
      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 60_000, message: `expected test draft "${subject}" to render in Drafts` },
      ).toBeGreaterThan(0);

      await page.locator('.msg-list__item').filter({ hasText: subject }).first().click();
      await expect(page.locator('.message-view__title h2')).toHaveText(subject, { timeout: 30_000 });

      await page.getByTitle('Delete').click();

      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: 'deleted draft should disappear from the Drafts list' },
      ).toBe(0);

      // Cache invariant: the local SQLite view must agree with the UI.
      // If query_view_items / folder_memberships still reference this
      // message, the next refresh would re-render it. The applyMove
      // path inside the outbox is what makes this true synchronously
      // after the JMAP round trip; this assertion guards that contract.
      const draftsCache = await readViewCacheForFolderRole(page, 'drafts');
      expect(draftsCache, 'local Drafts cache should be reachable via window.__repo').not.toBeNull();
      expect(draftsCache.remoteIds, 'remote id should be gone from Drafts cache').not.toContain(createdId);

      try {
        await expect.poll(
          async () => classifyMailboxState(await getEmailMailboxIds(jmap, createdId), { source: drafts, trash }),
          { timeout: 60_000, message: 'server should report the deleted message in Trash, not Drafts' },
        ).toBe('trash');
      } catch (err) {
        const mutationRows = await readRecentMutations(page);
        await testInfo.attach('recent-mutations.json', {
          body: JSON.stringify(mutationRows, null, 2),
          contentType: 'application/json',
        });
        throw err;
      }
    } finally {
      await testInfo.attach('console-tail.txt', {
        body: consoleLines.slice(-150).join('\n'),
        contentType: 'text/plain',
      });
      if (createdId) {
        await cleanupEmail(jmap, createdId, trash.id);
      }
    }
  });

  test('delete moves a real server-side Inbox message to Trash', async ({ page }, testInfo) => {
    const consoleLines = [];
    page.on('console', (msg) => {
      consoleLines.push(`[${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      consoleLines.push(`[pageerror] ${err.message}`);
    });

    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const trash = mailboxByRole(mailboxes, 'trash');
    if (!inbox || !trash) {
      throw new Error(`Test requires Inbox and Trash mailboxes; saw ${mailboxes.map((m) => `${m.name}:${m.role}`).join(', ')}`);
    }

    const selfEmail = STAGE_SELF_EMAIL
      || (STAGE_USERNAME.includes('@') ? STAGE_USERNAME : null);
    if (!selfEmail) {
      throw new Error('Set STAGE_SELF_EMAIL to a full address for this account.');
    }

    const subject = `Delete inbox e2e ${Date.now()}`;
    let inboxMessageId = null;
    try {
      inboxMessageId = await createEmailInMailbox(jmap, {
        mailboxId: inbox.id,
        fromEmail: selfEmail,
        subject,
      });
      await expect.poll(
        async () => classifyMailboxState(await getEmailMailboxIds(jmap, inboxMessageId), {
          source: inbox,
          trash,
        }),
        { timeout: 30_000, message: 'created test message should start in Inbox' },
      ).toBe('source');

      await login(page);
      await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });

      await clickFolder(page, inbox.name);
      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 60_000, message: `expected test message "${subject}" to render in Inbox` },
      ).toBeGreaterThan(0);

      await page.locator('.msg-list__item').filter({ hasText: subject }).first().click();
      await expect(page.locator('.message-view__title h2')).toHaveText(subject, { timeout: 30_000 });

      await page.getByTitle('Delete').click();

      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: 'deleted message should disappear from the Inbox list' },
      ).toBe(0);

      // Cache invariant: see the Drafts test above. Specifically for
      // Inbox this is the bug the user reported - the row was gone
      // from the DOM but the next virtualiser pass brought it back
      // because folder_memberships / query_view_items still pointed
      // to Inbox. The outbox's applyMoveLocally helper is what makes
      // this assertion hold immediately after the click.
      const inboxCache = await readViewCacheForFolderRole(page, 'inbox');
      expect(inboxCache, 'local Inbox cache should be reachable via window.__repo').not.toBeNull();
      expect(inboxCache.remoteIds, 'remote id should be gone from Inbox cache').not.toContain(inboxMessageId);

      try {
        await expect.poll(
          async () => classifyMailboxState(await getEmailMailboxIds(jmap, inboxMessageId), {
            source: inbox,
            trash,
          }),
          { timeout: 60_000, message: 'server should report the deleted Inbox message in Trash, not Inbox' },
        ).toBe('trash');
      } catch (err) {
        const mutationRows = await readRecentMutations(page);
        await testInfo.attach('recent-mutations.json', {
          body: JSON.stringify(mutationRows, null, 2),
          contentType: 'application/json',
        });
        throw err;
      }
    } finally {
      await testInfo.attach('console-tail.txt', {
        body: consoleLines.slice(-150).join('\n'),
        contentType: 'text/plain',
      });
      if (inboxMessageId) {
        await cleanupEmail(jmap, inboxMessageId, trash.id);
      }
    }
  });
});

async function login(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Thundermail' })).toBeVisible();
  await page.getByRole('button', { name: /use app password instead/i }).click();
  await page.getByLabel('Username').fill(STAGE_USERNAME);
  await page.getByLabel('App password').fill(STAGE_PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
}

async function clickFolder(page, name) {
  const folder = page.locator('.folder-node').filter({ hasText: new RegExp(escapeRegExp(name), 'i') }).first();
  await expect(folder).toBeVisible({ timeout: 30_000 });
  await folder.click();
  await expect.poll(
    async () => ((await page.locator('.folder-node.is-current').first().textContent()) ?? '').toLowerCase(),
    { timeout: 10_000, message: `expected ${name} to be selected` },
  ).toContain(name.toLowerCase());
}

async function readRecentMutations(page) {
  return page.evaluate(async () => {
    if (!globalThis.__repo) return [];
    return globalThis.__repo.call('db.query', {
      sql: `SELECT mutation_type, local_status, request_json, error_json
              FROM pending_mutations
             ORDER BY created_at DESC
             LIMIT 5`,
      params: [],
    });
  });
}

/**
 * Read the local SQLite cache state for a folder's mailbox-window
 * view. Returns { total, remoteIds } where remoteIds is the list of
 * messages currently in the view at any cached position. Used after
 * a delete to assert that the cache (not just the rendered DOM)
 * reflects the new state, so the bug "row reappears after the
 * virtualiser re-renders" cannot regress silently.
 */
async function readViewCacheForFolderRole(page, role) {
  return page.evaluate(async (wantedRole) => {
    if (!globalThis.__repo) return null;
    const accounts = await globalThis.__repo.listAccounts();
    const account = accounts?.[0];
    if (!account) return null;
    const folders = await globalThis.__repo.listFolders(account.id);
    const folder = folders.find((f) => f.role === wantedRole);
    if (!folder) return null;
    const sort = folder.role === 'sent' || folder.role === 'drafts' ? 'sent' : 'received';
    const progress = await globalThis.__repo.queryViewProgress({
      accountId: account.id,
      folderId: folder.id,
      sort,
    });
    const rows = await globalThis.__repo.listMessagesForView({
      accountId: account.id,
      folderId: folder.id,
      sort,
      offset: 0,
      limit: 500,
    });
    return {
      total: Number(progress?.total ?? 0),
      remoteIds: rows.map((r) => r.remote_id),
    };
  }, role);
}

async function connectJmap() {
  const authHeader = basicAuthHeader(STAGE_USERNAME, STAGE_PASSWORD);
  const sessionResponse = await fetch(`${JMAP_BASE_URL.replace(/\/$/, '')}/.well-known/jmap`, {
    headers: { Authorization: authHeader },
  });
  if (!sessionResponse.ok) {
    throw new Error(`Session fetch failed: ${sessionResponse.status} ${sessionResponse.statusText}`);
  }
  const session = await sessionResponse.json();
  const mailAccountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'];
  if (!mailAccountId) {
    throw new Error('JMAP session has no primary mail account');
  }
  return {
    apiUrl: session.apiUrl,
    accountId: mailAccountId,
    authHeader,
  };
}

async function jmapRequest(jmap, methodCalls) {
  const response = await fetch(jmap.apiUrl, {
    method: 'POST',
    headers: {
      Authorization: jmap.authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      using: [
        'urn:ietf:params:jmap:core',
        'urn:ietf:params:jmap:mail',
      ],
      methodCalls,
    }),
  });
  if (!response.ok) {
    throw new Error(`JMAP request failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  const errorResponse = payload.methodResponses?.find((r) => r[0] === 'error');
  if (errorResponse) {
    throw new Error(`JMAP method error: ${JSON.stringify(errorResponse[1])}`);
  }
  return payload;
}

function pickResponse(payload, name) {
  const found = payload.methodResponses?.find((r) => r[0] === name);
  return found?.[1] ?? null;
}

async function listMailboxes(jmap) {
  const payload = await jmapRequest(jmap, [[
    'Mailbox/get',
    {
      accountId: jmap.accountId,
      properties: ['id', 'name', 'role'],
    },
    'm1',
  ]]);
  return pickResponse(payload, 'Mailbox/get')?.list ?? [];
}

function mailboxByRole(mailboxes, role) {
  return mailboxes.find((m) => m.role === role) ?? null;
}

async function createDraft(jmap, { draftsId, fromEmail, subject }) {
  const payload = await jmapRequest(jmap, [[
    'Email/set',
    {
      accountId: jmap.accountId,
      create: {
        c1: {
          mailboxIds: { [draftsId]: true },
          keywords: { $draft: true },
          from: [{ email: fromEmail }],
          to: [{ email: fromEmail }],
          subject,
          bodyStructure: { type: 'text/plain', partId: 'p1' },
          bodyValues: {
            p1: { value: 'delete e2e disposable draft' },
          },
        },
      },
    },
    's1',
  ]]);
  const set = pickResponse(payload, 'Email/set');
  if (set?.notCreated?.c1) {
    throw new Error(`Could not create test draft: ${JSON.stringify(set.notCreated.c1)}`);
  }
  const id = set?.created?.c1?.id;
  if (!id) throw new Error(`Email/set create returned no id: ${JSON.stringify(set)}`);
  return id;
}

async function createEmailInMailbox(jmap, { mailboxId, fromEmail, subject }) {
  const payload = await jmapRequest(jmap, [[
    'Email/set',
    {
      accountId: jmap.accountId,
      create: {
        c1: {
          mailboxIds: { [mailboxId]: true },
          keywords: {},
          from: [{ email: fromEmail }],
          to: [{ email: fromEmail }],
          subject,
          bodyStructure: { type: 'text/plain', partId: 'p1' },
          bodyValues: {
            p1: { value: 'delete inbox e2e disposable message' },
          },
        },
      },
    },
    's1',
  ]]);
  const set = pickResponse(payload, 'Email/set');
  if (set?.notCreated?.c1) {
    throw new Error(`Could not create test email: ${JSON.stringify(set.notCreated.c1)}`);
  }
  const id = set?.created?.c1?.id;
  if (!id) throw new Error(`Email/set create returned no id: ${JSON.stringify(set)}`);
  return id;
}

async function getEmailMailboxIds(jmap, emailId) {
  const payload = await jmapRequest(jmap, [[
    'Email/get',
    {
      accountId: jmap.accountId,
      ids: [emailId],
      properties: ['mailboxIds'],
    },
    'g1',
  ]]);
  const row = pickResponse(payload, 'Email/get')?.list?.[0] ?? null;
  return row?.mailboxIds ?? null;
}

async function destroyEmail(jmap, emailId) {
  const payload = await jmapRequest(jmap, [[
    'Email/set',
    {
      accountId: jmap.accountId,
      destroy: [emailId],
    },
    'd1',
  ]]);
  const set = pickResponse(payload, 'Email/set');
  if (set?.notDestroyed?.[emailId]) {
    throw new Error(`Could not destroy cleanup email ${emailId}: ${JSON.stringify(set.notDestroyed[emailId])}`);
  }
}

async function cleanupEmail(jmap, emailId, trashId) {
  const mailboxIds = await getEmailMailboxIds(jmap, emailId);
  if (!mailboxIds) return;
  if (mailboxIds[trashId] !== true) {
    const update = { [`mailboxIds/${trashId}`]: true };
    for (const mailboxId of Object.keys(mailboxIds)) {
      if (mailboxId !== trashId) update[`mailboxIds/${mailboxId}`] = null;
    }
    const payload = await jmapRequest(jmap, [[
      'Email/set',
      {
        accountId: jmap.accountId,
        update: {
          [emailId]: update,
        },
      },
      'u1',
    ]]);
    const set = pickResponse(payload, 'Email/set');
    if (set?.notUpdated?.[emailId]) {
      throw new Error(`Could not move cleanup email ${emailId} to Trash: ${JSON.stringify(set.notUpdated[emailId])}`);
    }
  }
  await destroyEmail(jmap, emailId);
}

/**
 * Sweep any leftover test messages out of the live account. Tests
 * tag their disposable messages with subjects starting "Delete e2e"
 * or "Delete inbox e2e". A previous interrupted run might have left
 * one of those anywhere; we scan every mailbox, then destroy.
 *
 * Quiet by default - no throws - so it cannot break a test that is
 * otherwise green.
 */
async function sweepOrphanTestMessages(jmap) {
  // Scrub any "Delete e2e ..." / "Delete inbox e2e ..." messages from
  // every mailbox EXCEPT Sent. The user opted out of automatic cleanup
  // of their Sent folder (which accumulated noise from an older test
  // design that submitted real outgoing messages); the current test
  // design uses Email/set create directly into Inbox/Drafts so no Sent
  // copies will be created going forward. This sweep is for orphans
  // from Ctrl+C'd runs, not for retroactively scrubbing Sent.
  //
  // RFC 8621 §4.4.1: the `subject` filter requires every word in the
  // condition to appear (case-insensitive). "Delete e2e" matches both
  // "Delete e2e ..." and "Delete inbox e2e ..." subjects.
  try {
    const mailboxes = await listMailboxes(jmap);
    const sent = mailboxes.find((m) => m.role === 'sent');
    const filter = sent
      ? {
        operator: 'AND',
        conditions: [
          { subject: 'Delete e2e' },
          { operator: 'NOT', conditions: [{ inMailbox: sent.id }] },
        ],
      }
      : { subject: 'Delete e2e' };

    const payload = await jmapRequest(jmap, [[
      'Email/query',
      {
        accountId: jmap.accountId,
        filter,
        limit: 100,
      },
      'q1',
    ]]);
    const ids = pickResponse(payload, 'Email/query')?.ids ?? [];
    if (ids.length === 0) return;
    await jmapRequest(jmap, [[
      'Email/set',
      {
        accountId: jmap.accountId,
        destroy: ids,
      },
      's1',
    ]]);
  } catch (err) {
    console.warn('[delete-message.spec] sweepOrphanTestMessages failed:', err?.message ?? err);
  }
}

function classifyMailboxState(mailboxIds, { source, trash }) {
  if (!mailboxIds) return 'missing';
  const inSource = mailboxIds[source.id] === true;
  const inTrash = mailboxIds[trash.id] === true;
  if (inTrash && !inSource) return 'trash';
  if (inSource) return 'source';
  return JSON.stringify(mailboxIds);
}

function basicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
