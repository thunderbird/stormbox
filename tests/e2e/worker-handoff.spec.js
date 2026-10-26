import { test, expect } from '@playwright/test';

const fixture = '/tests/fixtures/worker-handoff/index.html';
const open = async (page, version = 'one', extra = '') => {
  await page.goto(`${fixture}?version=${version}${extra}`);
  await expect(page.locator('[data-connected]')).toBeVisible();
};
const sql = (page, statement) => page.evaluate((sql) => window.testRepo.call('db.query', { sql }), statement);
const exec = (page, statement) => page.evaluate((sql) => window.testRepo.call('db.exec', { sql }), statement);
const locks = (page) => page.evaluate(() => navigator.locks.query());
const lockCount = (page) => page.evaluate(() => new Promise((resolve) => {
  window.testWorker.port.addEventListener('message', function receive({ data }) {
    if (data?.type === 'fixture.lock-count') {
      window.testWorker.port.removeEventListener('message', receive);
      resolve(data.requests);
    }
  });
  window.testWorker.port.postMessage({ type: 'fixture.lock-count' });
}));

test('holds locks only in Firefox and preserves commit and rollback semantics', async ({ page, browserName }) => {
  await open(page, 'one', '&measure');
  await exec(page, 'CREATE TABLE fixture_counter(n INTEGER); INSERT INTO fixture_counter VALUES (0);');
  const initial = await locks(page);
  const initialRequests = await lockCount(page);
  const expected = browserName === 'firefox' ? 'exclusive' : 'normal';
  expect((await sql(page, 'PRAGMA main.locking_mode'))[0].locking_mode).toBe(expected);
  await exec(page, 'BEGIN IMMEDIATE; UPDATE fixture_counter SET n=7; COMMIT;');
  await exec(page, 'BEGIN IMMEDIATE; UPDATE fixture_counter SET n=8; ROLLBACK;');
  for (let i = 0; i < 25; i++) expect(await sql(page, 'SELECT n FROM fixture_counter')).toEqual([{ n: 7 }]);
  expect(await sql(page, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  expect((await locks(page)).held.map(({ name }) => name).sort()).toEqual(initial.held.map(({ name }) => name).sort());
  expect(initial.held.some(({ name }) => name === 'stormbox.database-owner')).toBe(browserName === 'firefox');
  const extraRequests = await lockCount(page) - initialRequests;
  if (browserName === 'firefox') expect(extraRequests).toBe(0);
  else expect(extraRequests).toBeGreaterThan(0);
  console.log(`${browserName}: ${extraRequests} new Web Lock requests after initialization`);
  await page.reload();
  await expect(page.locator('[data-connected]')).toBeVisible();
  expect(await sql(page, 'SELECT n FROM fixture_counter')).toEqual([{ n: 7 }]);
});

test('hands off to a new worker and reloads older tabs without losing committed data', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'firefox', 'Automatic exclusive-owner handoff is Firefox-only.');
  await open(page);
  await exec(page, 'CREATE TABLE fixture_handoff(n INTEGER); INSERT INTO fixture_handoff VALUES (42);');
  const old = await page.evaluate(() => window.testRepo.getWorkerStatus());
  const sameVersion = await context.newPage();
  await open(sameVersion);
  expect(await sameVersion.evaluate(() => window.testRepo.getWorkerStatus())).toMatchObject({ instanceId: old.instanceId });
  await page.evaluate(() => localStorage.setItem('fixture.latestVersion', 'two'));
  const replacement = await context.newPage();
  await open(replacement, 'two');
  for (const tab of [page, sameVersion]) {
    await expect(tab).toHaveURL(/version=two$/);
    await expect(tab.locator('[data-connected]')).toBeVisible();
  }
  const next = await replacement.evaluate(() => window.testRepo.getWorkerStatus());
  expect(next.instanceId).not.toBe(old.instanceId);
  for (const tab of [page, sameVersion, replacement]) {
    expect(await tab.evaluate(() => window.testRepo.getWorkerStatus())).toMatchObject({ instanceId: next.instanceId });
    expect(await sql(tab, 'SELECT n FROM fixture_handoff')).toEqual([{ n: 42 }]);
  }
  expect((await locks(replacement)).pending).toEqual([]);
});

test('keeps Chromium versions on normal locking without reloading existing tabs', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium');
  await open(page);
  const replacement = await context.newPage();
  await open(replacement, 'two');
  await expect(page).toHaveURL(/version=one$/);
  expect((await sql(replacement, 'PRAGMA main.locking_mode'))[0].locking_mode).toBe('normal');
});

test('retires a legacy owner that does not understand the handoff protocol', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'firefox');
  await open(page, 'legacy', '&legacy');
  expect((await sql(page, 'PRAGMA main.locking_mode'))[0].locking_mode).toBe('normal');
  await exec(page, 'CREATE TABLE fixture_legacy(n INTEGER); INSERT INTO fixture_legacy VALUES (17);');
  await page.evaluate(() => localStorage.setItem('fixture.latestVersion', 'two'));
  const replacement = await context.newPage();
  await open(replacement, 'two');
  await expect(page).toHaveURL(/version=two$/);
  await expect(page.locator('[data-connected]')).toBeVisible();
  expect(await sql(replacement, 'SELECT n FROM fixture_legacy')).toEqual([{ n: 17 }]);
});

test('a frozen owner produces the existing connection error UI without stealing its lock', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'firefox');
  await open(page, 'frozen', '&frozen');
  await exec(page, 'CREATE TABLE fixture_interrupted(n INTEGER); INSERT INTO fixture_interrupted VALUES (1);');
  await exec(page, 'BEGIN IMMEDIATE; UPDATE fixture_interrupted SET n=2;');
  await page.evaluate(() => new Promise((resolve) => {
    window.testWorker.port.addEventListener('message', function receive({ data }) {
      if (data?.type === 'fixture.frozen') {
        window.testWorker.port.removeEventListener('message', receive);
        resolve();
      }
    });
    window.testWorker.port.postMessage({ type: 'fixture.freeze' });
  }));
  const replacement = await context.newPage();
  await replacement.goto(`${fixture}?version=two`);
  const error = replacement.locator('.login-card__error[role="alert"]');
  await expect(error).toContainText('Close all Stormbox tabs and windows', { timeout: 25_000 });
  await expect(error).toContainText('restart Firefox');
  await expect(replacement.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(replacement.locator('.login-card__spinner')).toHaveCount(0);
  expect((await locks(replacement)).pending.some(({ name }) => name === 'stormbox.database-owner')).toBe(true);
  await replacement.screenshot({ path: 'test-results/firefox-database-recovery.png' });
  await page.close();
  await replacement.close();
  const reopened = await context.newPage();
  await open(reopened, 'two');
  expect(await sql(reopened, 'SELECT n FROM fixture_interrupted')).toEqual([{ n: 1 }]);
  expect(await sql(reopened, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
});

test('database recovery uses the real retry action even in app-password mode', async ({ page, browserName }) => {
  test.skip(browserName !== 'firefox');
  await page.goto(`${fixture}?version=silent&silent&app-password`);
  await expect(page.getByRole('alert')).toContainText('Close all Stormbox tabs and windows', { timeout: 25_000 });
  await expect(page.locator('form')).toHaveCount(0);
  await Promise.all([
    page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() }),
    page.getByRole('button', { name: 'Try again' }).click(),
  ]);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.login-card__spinner')).toBeVisible();
});
