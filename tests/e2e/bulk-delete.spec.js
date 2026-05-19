import { test, expect } from '@playwright/test';

/**
 * Regression for "multi-select bulk delete leaves rows visible in the
 * local list" — the user-reported Firefox bug where the JMAP round
 * trip succeeded but the Inbox list never re-rendered to drop the
 * deleted rows.
 *
 * The test creates several disposable Inbox messages, multi-selects
 * them through the checkbox UI (the Fastmail-style selection model
 * used by multi-select.spec.js), clicks the bulk Delete button, and
 * asserts:
 *
 *   1. The rendered UI list no longer contains any of the deleted
 *      subjects.
 *   2. window.__repo.listMessagesForView for the Inbox has none of
 *      the deleted remote ids — i.e. the local SQLite cache agrees
 *      with the UI.
 *   3. The server reports each deleted message in Trash, not Inbox.
 *   4. Exactly one network round trip was sufficient (covered at the
 *      outbox + integration layers; here we only assert the
 *      user-visible outcome).
 *
 * Runs on both Chromium and Firefox via the playwright projects
 * config. The Firefox run is the one that actually reproduces the
 * reported bug.
 */

const STAGE_USERNAME = process.env.STAGE_USERNAME;
const STAGE_PASSWORD = process.env.STAGE_PASSWORD;
const STAGE_SELF_EMAIL = process.env.STAGE_SELF_EMAIL;
const JMAP_BASE_URL = process.env.STAGE_JMAP_URL ?? 'https://mail.stage-thundermail.com';

test.skip(
  !STAGE_USERNAME || !STAGE_PASSWORD,
  'STAGE_USERNAME / STAGE_PASSWORD not set; live-stage bulk-delete e2e skipped',
);

test.describe('Bulk delete e2e', () => {
  test.setTimeout(180_000);

  test.beforeEach(async () => {
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap);
  });

  test('multi-select delete drops every row from the Inbox list (UI + cache)', async ({ page }, testInfo) => {
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

    // Three disposable messages. We use a shared subject prefix so
    // sweepOrphanTestMessages can scrub them on the next run if this
    // test is interrupted mid-flight.
    const stamp = Date.now();
    const subjects = [
      `Delete e2e bulk ${stamp} a`,
      `Delete e2e bulk ${stamp} b`,
      `Delete e2e bulk ${stamp} c`,
    ];
    const createdIds = [];
    try {
      for (const subject of subjects) {
        const id = await createEmailInMailbox(jmap, {
          mailboxId: inbox.id,
          fromEmail: selfEmail,
          subject,
        });
        createdIds.push(id);
      }

      await login(page);
      await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });

      await clickFolder(page, inbox.name);
      for (const subject of subjects) {
        await expect.poll(
          async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
          { timeout: 60_000, message: `expected test message "${subject}" to render in Inbox` },
        ).toBeGreaterThan(0);
      }

      // Check each test row via the leading checkbox. The Fastmail
      // selection model: checkbox click toggles selection without
      // moving focus, so the right pane switches to the bulk summary
      // once any row is checked.
      for (const subject of subjects) {
        const row = page.locator('.msg-list__items > li')
          .filter({ hasText: subject })
          .first();
        await row.locator('.msg-list__check input').click();
      }
      await expect(page.locator('.msg-list__count'))
        .toHaveText(/^3 selected/, { timeout: 5_000 });

      // Click the bulk Delete button (lives inside the bulk summary
      // panel, not the article toolbar). Scope by container to avoid
      // accidentally hitting the single-message Delete button if both
      // are mounted at the same time.
      await page.locator('.message-view__bulk-actions [title="Delete"]').click();

      // PRIMARY ASSERTION: the rendered UI must drop every deleted
      // row. This is the exact symptom the user reported.
      for (const subject of subjects) {
        await expect.poll(
          async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
          { timeout: 30_000, message: `deleted bulk row "${subject}" should disappear from Inbox` },
        ).toBe(0);
      }

      // Cache invariant: window.__repo agrees with the UI. If the
      // user's actual complaint were "row visible despite cache being
      // clean", this would pass; if it were "cache still has the
      // row", this would fail and we'd know to fix applyMoveLocally
      // or the broadcast. Either way it is the right thing to pin.
      const inboxCache = await readViewCacheForFolderRole(page, 'inbox');
      expect(inboxCache, 'local Inbox cache should be reachable via window.__repo').not.toBeNull();
      for (const remoteId of createdIds) {
        expect(
          inboxCache.remoteIds,
          `remote id ${remoteId} should be gone from the Inbox cache`,
        ).not.toContain(remoteId);
      }

      // Server-side check: each test message ended up in Trash.
      for (const remoteId of createdIds) {
        try {
          await expect.poll(
            async () => classifyMailboxState(
              await getEmailMailboxIds(jmap, remoteId),
              { source: inbox, trash },
            ),
            {
              timeout: 60_000,
              message: `server should report ${remoteId} in Trash, not Inbox`,
            },
          ).toBe('trash');
        } catch (err) {
          const mutationRows = await readRecentMutations(page);
          await testInfo.attach('recent-mutations.json', {
            body: JSON.stringify(mutationRows, null, 2),
            contentType: 'application/json',
          });
          throw err;
        }
      }
    } finally {
      await testInfo.attach('console-tail.txt', {
        body: consoleLines.slice(-200).join('\n'),
        contentType: 'text/plain',
      });
      for (const id of createdIds) {
        await cleanupEmail(jmap, id, trash.id);
      }
    }
  });
});

// ----------- helpers (mirror the ones in delete-message.spec.js) ----

async function login(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Thundermail' })).toBeVisible();
  await page.getByRole('button', { name: /use app password instead/i }).click();
  await page.getByLabel('Username').fill(STAGE_USERNAME);
  await page.getByLabel('App password').fill(STAGE_PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
}

async function clickFolder(page, name) {
  const folder = page.locator('.folder-node')
    .filter({ hasText: new RegExp(escapeRegExp(name), 'i') })
    .first();
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
  if (!mailAccountId) throw new Error('JMAP session has no primary mail account');
  return { apiUrl: session.apiUrl, accountId: mailAccountId, authHeader };
}

async function jmapRequest(jmap, methodCalls) {
  const response = await fetch(jmap.apiUrl, {
    method: 'POST',
    headers: {
      Authorization: jmap.authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
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
    { accountId: jmap.accountId, properties: ['id', 'name', 'role'] },
    'm1',
  ]]);
  return pickResponse(payload, 'Mailbox/get')?.list ?? [];
}

function mailboxByRole(mailboxes, role) {
  return mailboxes.find((m) => m.role === role) ?? null;
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
          bodyValues: { p1: { value: 'bulk-delete e2e disposable message' } },
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
    { accountId: jmap.accountId, ids: [emailId], properties: ['mailboxIds'] },
    'g1',
  ]]);
  const row = pickResponse(payload, 'Email/get')?.list?.[0] ?? null;
  return row?.mailboxIds ?? null;
}

async function destroyEmail(jmap, emailId) {
  const payload = await jmapRequest(jmap, [[
    'Email/set',
    { accountId: jmap.accountId, destroy: [emailId] },
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
      { accountId: jmap.accountId, update: { [emailId]: update } },
      'u1',
    ]]);
    const set = pickResponse(payload, 'Email/set');
    if (set?.notUpdated?.[emailId]) {
      throw new Error(`Could not move cleanup email ${emailId} to Trash: ${JSON.stringify(set.notUpdated[emailId])}`);
    }
  }
  await destroyEmail(jmap, emailId);
}

async function sweepOrphanTestMessages(jmap) {
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
      { accountId: jmap.accountId, filter, limit: 100 },
      'q1',
    ]]);
    const ids = pickResponse(payload, 'Email/query')?.ids ?? [];
    if (ids.length === 0) return;
    await jmapRequest(jmap, [[
      'Email/set',
      { accountId: jmap.accountId, destroy: ids },
      's1',
    ]]);
  } catch (err) {
    console.warn('[bulk-delete.spec] sweepOrphanTestMessages failed:', err?.message ?? err);
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
