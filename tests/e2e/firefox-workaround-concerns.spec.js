import { test, expect } from '@playwright/test';

const fixture = '/tests/fixtures/worker-handoff/';
const open = async (page, version, flags = '') => {
  await page.goto(`${fixture}index.html?version=${version}${flags}`);
  await expect(page.locator('[data-connected]')).toBeVisible();
};
const sql = (page, statement) => page.evaluate(sql => window.testRepo.call('db.query', { sql }), statement);
const exec = (page, statement) => page.evaluate(sql => window.testRepo.call('db.exec', { sql }), statement);
const attach = (info, name, value) => info.attach(name, {
  body: JSON.stringify(value, null, 2), contentType: 'application/json',
});
const probe = (page, type) => page.evaluate(type => new Promise(resolve => {
  const port = window.testWorker.port;
  const receive = ({ data }) => {
    if (data?.type === type) { port.removeEventListener('message', receive); resolve(data); }
  };
  port.addEventListener('message', receive);
  port.postMessage({ type });
}), type);

test('large contact transactions commit and roll back after journal reuse', async ({ page }) => {
  await open(page, 'large-journal');
  await exec(page, "INSERT INTO accounts (id, server_origin, remote_account_id, created_at, updated_at) VALUES (1, 'fixture', '1', 0, 0)");
  for (const count of [100, 10_000]) {
    await page.evaluate(async count => {
      const contacts = Array.from({ length: count }, (_, index) => ({
        remoteId: `fixture-${index}`,
        uid: `urn:uuid:fixture-${index}`,
        displayName: `Journal fixture ${index}`,
        fullName: `Journal fixture ${index}`,
        emails: [], phones: [], links: [], anniversaries: [],
        notes: [], organizations: [], titles: [],
      }));
      await window.testRepo.upsertContacts(1, contacts);
    }, count);
    expect(await sql(page, 'SELECT COUNT(*) AS count FROM contacts')).toEqual([{ count }]);
  }
  await exec(page, "BEGIN; UPDATE contacts SET display_name = 'committed'; COMMIT;");
  await exec(page, "BEGIN; UPDATE contacts SET display_name = 'rolled back'; ROLLBACK;");
  expect(await sql(page, "SELECT COUNT(*) AS count FROM contacts WHERE display_name = 'committed'"))
    .toEqual([{ count: 10_000 }]);
  expect(await sql(page, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
});

async function blockIndexedDB(page) {
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('idb-stormbox');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['blocks', 'metadata'], 'readwrite');
    const state = window.testIDBBlocker = { released: false, complete: false, reads: 0 };
    window.releaseIDBBlocker = () => { state.released = true; };
    tx.oncomplete = () => { state.complete = true; db.close(); };
    await new Promise((resolve, reject) => {
      tx.onabort = () => reject(tx.error);
      const keepAlive = () => {
        const request = tx.objectStore('metadata').get('__fixture_absent__');
        request.onsuccess = () => {
          if (++state.reads === 1) resolve();
          if (!state.released) keepAlive();
        };
      };
      keepAlive();
    });
  });
}

for (const mode of ['EXCLUSIVE+NORMAL', 'EXCLUSIVE+FULL', 'NORMAL+NORMAL']) {
  test(`commit waits for IndexedDB writes: ${mode}`, async ({ page, browserName }, info) => {
    test.skip(browserName !== 'firefox');
    await open(page, mode, '&storage-probe');
    if (mode === 'NORMAL+NORMAL') await exec(page, 'PRAGMA main.locking_mode=NORMAL;');
    await exec(page, 'CREATE TABLE fixture_checkpoint(phase TEXT); INSERT INTO fixture_checkpoint VALUES (\'queued\');');
    if (mode === 'EXCLUSIVE+FULL') await exec(page, 'PRAGMA synchronous=FULL;');
    expect((await sql(page, 'PRAGMA main.locking_mode'))[0].locking_mode).toBe(mode.split('+')[0].toLowerCase());
    expect((await sql(page, 'PRAGMA synchronous'))[0].synchronous).toBe(mode.endsWith('+FULL') ? 2 : 1);
    const journalMode = (await sql(page, 'PRAGMA journal_mode'))[0].journal_mode;
    expect(journalMode).toBe('delete');
    expect(await sql(page, 'SELECT phase FROM fixture_checkpoint')).toEqual([{ phase: 'queued' }]);
    await probe(page, 'fixture.arm-write');
    await page.evaluate(() => {
      window.testAtMainWrite = new Promise(resolve => {
        const receive = ({ data }) => {
          if (data?.type === 'fixture.before-main-write') {
            window.testWorker.port.removeEventListener('message', receive);
            resolve();
          }
        };
        window.testWorker.port.addEventListener('message', receive);
      });
      window.testCommit = { settled: false, error: null };
      window.testRepo.call('db.exec', {
        sql: "BEGIN IMMEDIATE; UPDATE fixture_checkpoint SET phase='submitting'; COMMIT;",
      }).then(() => { window.testCommit.settled = true; }, error => {
        window.testCommit.error = String(error);
        window.testCommit.settled = true;
      });
    });
    await page.evaluate(() => window.testAtMainWrite);
    // Block native IDB only after journal synchronization has finished.
    await blockIndexedDB(page);
    await page.evaluate(() => window.testWorker.port.postMessage({ type: 'fixture.resume-write' }));
    let evidence;
    try {
      await page.waitForTimeout(500);
      evidence = { ...await page.evaluate(() => ({ commit: window.testCommit, blocker: window.testIDBBlocker })),
        vfs: (await probe(page, 'fixture.storage-events')).events };
    } finally {
      await page.evaluate(() => window.releaseIDBBlocker());
    }
    await expect.poll(() => page.evaluate(() => window.testCommit.settled)).toBe(true);
    expect(await page.evaluate(() => window.testCommit.error)).toBeNull();
    expect(await sql(page, 'SELECT phase FROM fixture_checkpoint')).toEqual([{ phase: 'submitting' }]);
    await attach(info, 'blocked-indexeddb-commit', { mode, journalMode, ...evidence });
    expect(evidence.blocker.complete).toBe(false);
    expect(evidence.blocker.reads).toBeGreaterThan(1);
    expect(evidence.commit.settled).toBe(false);
    const mainWriteEnd = evidence.vfs.findIndex(event => event.method === 'jWrite'
      && event.phase === 'end' && event.file === '/stormbox.sqlite');
    expect(mainWriteEnd).toBeGreaterThan(-1);
    const afterWrite = evidence.vfs.slice(mainWriteEnd + 1);
    const barrier = mode === 'NORMAL+NORMAL' ? { method: 'jUnlock', arg: 0 }
      : { method: 'jSync', file: mode === 'EXCLUSIVE+NORMAL' ? '/stormbox.sqlite-journal' : '/stormbox.sqlite' };
    expect(afterWrite.at(-2)).toMatchObject({ ...barrier, phase: 'start' });
    expect(afterWrite.at(-1)).toMatchObject({ method: 'IDBContext.sync', phase: 'start', durable: mode !== 'NORMAL+NORMAL' });
  });
}

test('a superseded waiting version still receives its reload notification', async ({ page, context, browserName }, info) => {
  test.skip(browserName !== 'firefox');
  await open(page, 'A', '&frozen');
  await page.evaluate(() => new Promise(resolve => {
    window.testWorker.port.addEventListener('message', ({ data }) => {
      if (data?.type === 'fixture.frozen') resolve();
    });
    window.testWorker.port.postMessage({ type: 'fixture.freeze' });
  }));
  await page.evaluate(() => {
    window.testBroadcasts = [];
    window.testObserver = new BroadcastChannel(window.testChannelName);
    window.testObserver.onmessage = ({ data }) => window.testBroadcasts.push(data);
  });
  const waiting = await context.newPage();
  await waiting.goto(`${fixture}index.html?version=B&delay-retirement`);
  await expect.poll(() => waiting.evaluate(async () => (await navigator.locks.query()).pending.length)).toBe(1);
  await waiting.evaluate(() => {
    localStorage.setItem('fixture.latestVersion', 'C');
  });
  const replacement = await context.newPage();
  await replacement.goto(`${fixture}index.html?version=C`);
  await expect(waiting.getByRole('alert')).toContainText('Close all Stormbox tabs and windows');
  await expect.poll(() => page.evaluate(() => window.testBroadcasts.some(data => data.workerUrl?.includes('fixture-version=B')))).toBe(true);
  const broadcasts = await page.evaluate(() => window.testBroadcasts.filter(data => data.workerUrl || data.replacementWorkerUrl));
  await page.close();
  await expect(replacement.locator('[data-connected]')).toBeVisible({ timeout: 20_000 });
  const evidence = await waiting.evaluate(() => ({ url: location.href, connected: !!window.testRepo,
    error: document.querySelector('[role=alert]')?.textContent }));
  await attach(info, 'superseded-waiter', { ...evidence, broadcasts });
  expect(broadcasts.some(data => data.workerUrl?.includes('fixture-version=B'))).toBe(true);
  await expect(waiting).toHaveURL(/version=C$/, { timeout: 2_000 });
  await expect(waiting.locator('[data-connected]')).toBeVisible();
});

for (const failDatabase of [false, true]) {
  test(`background OIDC login ${failDatabase ? 'keeps database recovery visible' : 'resumes normally without database failure'}`, async ({ page }, info) => {
    // Substitute discovery and the remote IdP, not the library's login behavior.
    await page.route('**/src/services/auth.ts', route => route.fulfill({
      contentType: 'text/javascript',
      body: `export { initOidc, getOidc } from '${fixture}oidc-adapter.ts';`,
    }));
    await page.addInitScript(() => {
      if (location.pathname.endsWith('/oidc-login.html')) {
        localStorage.clear();
        sessionStorage.clear();
      }
      window.testVisibility = 'hidden';
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.testVisibility });
    });
    await page.goto(`${fixture}oidc-login.html`);
    await page.waitForFunction(() => !!window.testSettleDatabase);
    await page.waitForTimeout(100);
    const startedBeforeDatabase = await page.evaluate(() => !!window.testLoginStarted);
    expect(await page.evaluate(() => sessionStorage.getItem('fixture.redirect'))).toBeNull();
    await page.evaluate(fail => window.testSettleDatabase(fail), failDatabase);
    if (failDatabase) {
      await expect(page.getByRole('alert')).toContainText('Close all Stormbox tabs and windows');
      expect(await page.evaluate(() => window.testAuth.databaseUnavailable)).toBe(true);
    } else {
      await expect.poll(() => page.evaluate(() => window.testLoginStarted)).toBe(true);
    }
    await page.evaluate(() => {
      window.testVisibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    if (failDatabase) await page.waitForTimeout(500);
    else await expect(page).toHaveURL(/oidc-destination.html$/);
    const evidence = await page.evaluate(() => ({ url: location.href,
      redirect: JSON.parse(sessionStorage.getItem('fixture.redirect')) }));
    await attach(info, 'oidc-redirect-state', { ...evidence, startedBeforeDatabase });
    if (failDatabase) {
      expect(evidence.url).toMatch(/oidc-login.html$/);
      expect(evidence.redirect).toBeNull();
      expect(await page.evaluate(() => !!window.testLoginStarted)).toBe(false);
      await expect(page.getByRole('alert')).toContainText('Close all Stormbox tabs and windows');
    } else {
      expect(evidence.redirect.databaseUnavailable).toBe(false);
    }
    expect(startedBeforeDatabase).toBe(false);
  });
}
