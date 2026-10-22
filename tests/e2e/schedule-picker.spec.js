import { expect, resetSharedSession, test } from './helpers/shared-session.js';
import { waitForIdentities } from './helpers/compose.js';
import { connectJmap, downloadBlob, fileNodeRequest, pickResponse } from './helpers/jmap-client.js';
import { localStackEnabled, skipLocalStackMessage } from './helpers/stack-env.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

async function localSettings(page) {
  return page.evaluate(async () => {
    const [account] = await window.__repo.listAccounts();
    return window.__repo.getSettings(account.id);
  });
}

async function remoteTimeZone(page, jmap) {
  const nodeId = (await localSettings(page))?.remoteNodeId;
  if (!nodeId) return null;
  const response = await fileNodeRequest(jmap, [[
    'FileNode/get',
    { accountId: jmap.accountId, ids: [nodeId], properties: ['id', 'blobId'] },
    'time-zone-settings',
  ]]);
  const node = pickResponse(response, 'FileNode/get')?.list?.[0];
  if (!node?.blobId) return null;
  const bytes = await downloadBlob(jmap, {
    blobId: node.blobId, type: 'application/json', name: 'settings.json',
  });
  return JSON.parse(bytes.toString('utf8'))?.settings?.timeZone ?? null;
}

async function changeTimeZone(page, zone) {
  await page.locator('[data-settings-gear]').click();
  const settings = page.locator('[data-settings-dialog]');
  const picker = settings.locator('[data-time-zone-picker]');
  await picker.locator('summary').click();
  const search = picker.getByRole('searchbox', { name: 'Search time zones' });
  await expect(search).toBeFocused();
  await search.fill(zone);
  await picker.getByRole('button', { name: zone.replaceAll('_', ' '), exact: true }).click();
  await expect(picker.locator('summary')).toHaveText(zone);
  await expect(picker.locator('summary')).toBeFocused();
  await settings.getByRole('button', { name: 'Close settings' }).click();
}

test.beforeEach(async ({ sharedPage: page }) => {
  await resetSharedSession(page);
});

test('Settings time zone persists in the cache and server and drives the inline schedule picker', async ({ sharedPage: page }) => {
  test.setTimeout(120_000);
  const jmap = await connectJmap();
  const originalZone = await page.evaluate(async () => {
    const { useSettingsStore } = await import('/src/stores/settings-store.ts');
    return useSettingsStore().get('timeZone');
  });
  const zone = originalZone === 'Asia/Tokyo' ? 'America/New_York' : 'Asia/Tokyo';
  let sessionId;
  try {
    await changeTimeZone(page, zone);
    await expect.poll(async () => (await localSettings(page))?.doc?.settings?.timeZone).toBe(zone);
    await expect.poll(() => remoteTimeZone(page, jmap), { timeout: 30_000 }).toBe(zone);
    await page.reload();
    await page.locator('[data-settings-gear]').click();
    await expect(page.locator('[data-time-zone-picker] summary')).toHaveText(zone);
    await page.getByRole('button', { name: 'Close settings' }).click();

    sessionId = await page.evaluate(async () => {
      const { COMPOSE_OPEN_ORIGIN, useComposeStore } = await import('/src/stores/compose-store.ts');
      const store = useComposeStore();
      const id = store.open({ subject: 'Schedule picker review' }, { origin: COMPOSE_OPEN_ORIGIN.SERVER_DRAFT });
      store.holdAutosave(id);
      return id;
    });
    await waitForIdentities(page);
    const composer = page.locator('.compose-dialog--expanded');
    const trigger = composer.locator('.compose-schedule-menu__trigger');
    await expect(trigger).not.toHaveAttribute('aria-disabled', 'true');
    await trigger.click();
    await composer.getByRole('menuitem').filter({ hasText: 'Choose a date and time' }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose a date and time' });
    await expect(dialog.getByRole('grid')).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Datepicker input' })).toHaveCount(0);
    await expect(dialog.getByRole('searchbox')).toHaveCount(0);
    await expect(dialog).toContainText(`Current time zone: ${zone}`);
    await expect(dialog.getByRole('status')).toContainText('Sends');
    const initialLabel = await dialog.getByRole('status').innerText();
    const nextDay = dialog.locator('[role="gridcell"][aria-label]:not([aria-disabled="true"]):not([aria-selected="true"])');
    await nextDay.last().click();
    await expect(dialog.getByRole('status')).not.toHaveText(initialLabel);
    const selectedLabel = (await dialog.getByRole('status').innerText()).replace(/^Sends /, '').replace(/\.$/, '');
    await page.setViewportSize({ width: 375, height: 560 });
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(box.height).toBeLessThanOrEqual(528);
    const confirm = dialog.getByRole('button', { name: 'Set send time' });
    await confirm.focus();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close schedule dialog' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(confirm).toBeFocused();
    await confirm.click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toHaveAttribute('title', `Custom — ${selectedLabel}`);
    await expect(composer.locator('.compose-send')).toBeFocused();
  } finally {
    if (sessionId) await page.evaluate(async (id) => {
      const { useComposeStore } = await import('/src/stores/compose-store.ts');
      useComposeStore().close(id);
    }, sessionId);
    await page.setViewportSize({ width: 1280, height: 900 });
    const closeSettings = page.getByRole('button', { name: 'Close settings' });
    if (await closeSettings.isVisible()) await closeSettings.click();
    await changeTimeZone(page, originalZone);
    await expect.poll(() => remoteTimeZone(page, jmap), { timeout: 30_000 }).toBe(originalZone);
  }
});
