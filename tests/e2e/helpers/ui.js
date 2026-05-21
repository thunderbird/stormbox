import { expect } from '@playwright/test';

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function clickFolder(page, name) {
  const folder = page.locator('.folder-node').filter({ hasText: new RegExp(escapeRegExp(name), 'i') }).first();
  await expect(folder).toBeVisible({ timeout: 30_000 });
  await folder.click();
  await expect.poll(
    async () => ((await page.locator('.folder-node.is-current').first().textContent()) ?? '').toLowerCase(),
    { timeout: 10_000, message: `expected ${name} to be selected` },
  ).toContain(name.toLowerCase());
}

export async function waitForShellReady(page) {
  await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });
}

export async function waitForInboxReady(page) {
  await waitForShellReady(page);
  await expect.poll(
    async () => {
      const current = page.locator('.folder-node.is-current');
      if ((await current.count()) === 0) return '';
      return ((await current.first().textContent()) ?? '').toLowerCase();
    },
    { timeout: 30_000, message: 'expected Inbox to be auto-selected' },
  ).toMatch(/inbox/);
  await expect.poll(
    async () => page.locator('.msg-list__item').count(),
    { timeout: 60_000, message: 'expected at least one Inbox row to render' },
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
  await expect(scroller).toBeVisible({ timeout: 30_000 });
  await scroller.focus();
}

export async function openMessageBySubject(page, subject) {
  const row = page.locator('.msg-list__item').filter({ hasText: subject }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.locator('.msg-list__rows').click();
  await expect(page.locator('.message-view__title h2')).toHaveText(subject, { timeout: 30_000 });
}

export async function readOpenMessageSubject(page) {
  return ((await page.locator('.message-view__title h2').textContent()) ?? '').trim();
}
