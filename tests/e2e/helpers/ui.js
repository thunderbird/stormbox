import { expect } from '@playwright/test';

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Per-test e2e budget: nothing should wait longer than 30s for a UI
// state. The global Playwright test timeout caps each spec at 60s, so
// 30s here gives every spec headroom for two big waits plus a tail of
// smaller ones.
const WAIT_MS = 30_000;

export async function clickFolder(page, name) {
  const folder = page.locator('.folder-node').filter({ hasText: new RegExp(escapeRegExp(name), 'i') }).first();
  await expect(folder).toBeVisible({ timeout: WAIT_MS });
  await folder.click();
  await expect.poll(
    async () => ((await page.locator('.folder-node.is-current').first().textContent()) ?? '').toLowerCase(),
    { timeout: 10_000, message: `expected ${name} to be selected` },
  ).toContain(name.toLowerCase());
}

export async function waitForShellReady(page) {
  await expect(page.locator('.shell')).toBeVisible({ timeout: WAIT_MS });
}

// Wait until the folder tree has hydrated and Inbox is auto-selected.
// Stops short of asserting any rows in the message list — useful for
// shared-context beforeAll hooks where the previous test may have
// just emptied the Inbox via cleanup.
export async function waitForFolderTreeReady(page) {
  await waitForShellReady(page);
  await expect.poll(
    async () => {
      const current = page.locator('.folder-node.is-current');
      if ((await current.count()) === 0) return '';
      return ((await current.first().textContent()) ?? '').toLowerCase();
    },
    { timeout: WAIT_MS, message: 'expected Inbox to be auto-selected' },
  ).toMatch(/inbox/);
}

export async function waitForInboxReady(page) {
  await waitForFolderTreeReady(page);
  await expect.poll(
    async () => page.locator('.msg-list__item').count(),
    { timeout: WAIT_MS, message: 'expected at least one Inbox row to render' },
  ).toBeGreaterThan(0);
}

export async function readRecentMutations(page) {
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

export async function readViewCacheForFolderRole(page, role) {
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

// Read the local contacts cache via window.__repo (the same RPC the
// contacts store reads through). Returns one entry per non-deleted
// contact with its remote id, display name, and preferred email.
export async function readContactsCache(page) {
  return page.evaluate(async () => {
    if (!globalThis.__repo) return null;
    const accounts = await globalThis.__repo.listAccounts();
    const account = accounts?.[0];
    if (!account) return null;
    const rows = await globalThis.__repo.listContacts(account.id, { limit: 500 });
    return rows.map((r) => ({
      remote_id: r.remote_id,
      display_name: r.display_name,
      email: r.email,
    }));
  });
}

// Read the full ordered email list a contact carries in the local
// cache, matched by remote id. Used to assert multi-email edits landed
// in the cache, not just on the server.
export async function readContactEmailsFromCache(page, remoteId) {
  return page.evaluate(async (rid) => {
    if (!globalThis.__repo) return null;
    const accounts = await globalThis.__repo.listAccounts();
    const account = accounts?.[0];
    if (!account) return null;
    const rows = await globalThis.__repo.call('db.query', {
      sql: `SELECT ce.email
              FROM contact_emails ce
              JOIN contacts c ON c.id = ce.contact_id
             WHERE c.account_id = ? AND c.remote_id = ? AND c.is_deleted = 0
             ORDER BY ce.position`,
      params: [account.id, rid],
    });
    return rows.map((r) => r.email);
  }, remoteId);
}

export async function attachConsoleTail(testInfo, consoleLines, limit = 150) {
  await testInfo.attach('console-tail.txt', {
    body: consoleLines.slice(-limit).join('\n'),
    contentType: 'text/plain',
  });
}

export function trackConsole(page, consoleLines, { ensureLoaded = false } = {}) {
  page.on('console', (msg) => {
    const text = msg.text();
    consoleLines.push(`[${msg.type()}] ${text}`);
  });
  page.on('pageerror', (err) => {
    consoleLines.push(`[pageerror] ${err.message}`);
  });
  if (ensureLoaded) {
    page.on('console', (msg) => {
      if (/\[mail-store\] ensureLoaded failed/.test(msg.text())) {
        consoleLines.push(`[ensureLoaded-failure] ${msg.text()}`);
      }
    });
  }
}

export async function focusMessageList(page) {
  const scroller = page.locator('.msg-list__scroller');
  await expect(scroller).toBeVisible({ timeout: WAIT_MS });
  await scroller.focus();
}

export async function openMessageBySubject(page, subject) {
  const row = page.locator('.msg-list__item').filter({ hasText: subject }).first();
  await expect(row).toBeVisible({ timeout: WAIT_MS });
  await row.locator('.msg-list__content').click();
  await expect(page.locator('.message-view__title h2')).toHaveText(subject, { timeout: WAIT_MS });
  // Wait for the body to actually render (iframe for HTML or .text
  // fallback). Tests that immediately press a shortcut like Reply
  // depend on the body being in the cache; without this wait the
  // compose dialog opens with empty quoted content because the
  // body fetch hasn't completed when the shortcut fires. Faster
  // Stalwart made this race visible — pre-tmpfs the body fetch
  // happened to land in time on most runs.
  await expect.poll(
    async () => (
      await page.locator('iframe.message-view__html-frame').count()
    ) + (
      await page.locator('.message-view__text').count()
    ),
    { timeout: WAIT_MS, message: `expected message body to render for "${subject}"` },
  ).toBeGreaterThan(0);
}

// Wait for a row with the given subject to appear in whatever
// folder is currently selected. The fast path assumes JMAP push
// delivered the change; if push lags more than `pushBudgetMs` we
// fall through to an explicit refresh-button click (the same path
// the user takes when the UI looks stale) and keep polling.
//
// Earlier attempts to gate on a "WebSocket open, push enabled"
// console log proved unreliable — the SharedWorker log doesn't
// always propagate to the page console in time, so the gate
// itself became a flake source. The poll-then-refresh pattern
// here makes the test deterministic without depending on log
// observability.
export async function expectRowSoon(page, subject, {
  timeout = WAIT_MS,
  pushBudgetMs = 2_000,
} = {}) {
  const row = page.locator('.msg-list__item').filter({ hasText: subject });
  try {
    await expect.poll(
      async () => row.count(),
      { timeout: pushBudgetMs, message: `push delivery for "${subject}"` },
    ).toBeGreaterThan(0);
    return;
  } catch {
    // Fall through to manual refresh; the assertion below carries
    // the real failure message if the row still doesn't appear.
  }
  await page.locator('.msg-list__refresh').click().catch(() => {});
  await expect.poll(
    async () => row.count(),
    {
      timeout: Math.max(1_000, timeout - pushBudgetMs),
      message: `expected "${subject}" to render after manual refresh`,
    },
  ).toBeGreaterThan(0);
}

export async function readOpenMessageSubject(page) {
  return ((await page.locator('.message-view__title h2').textContent()) ?? '').trim();
}

export async function waitForPendingMutations(page, { timeout = WAIT_MS } = {}) {
  await expect.poll(
    async () => page.evaluate(async () => {
      if (!globalThis.__repo) return -1;
      const rows = await globalThis.__repo.call('db.query', {
        sql: `SELECT COUNT(*) AS c
                FROM pending_mutations
               WHERE local_status IN ('pending', 'retry')`,
        params: [],
      });
      return Number(rows?.[0]?.c ?? 0);
    }),
    { timeout, message: 'pending outbox mutations should drain' },
  ).toBe(0);
}
