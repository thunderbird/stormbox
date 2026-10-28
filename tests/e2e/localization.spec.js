import { test, expect } from '@playwright/test';
import { loginViaOidc } from './helpers/oidc-login.js';
import { localStackEnabled, skipLocalStackMessage } from './helpers/stack-env.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

test('switches a running interface, preserves the preference, and falls back per message', async ({ page }, info) => {
  await loginViaOidc(page);
  // The test supplies a partial catalog without publishing unreviewed translations.
  await page.evaluate(async () => {
    const { i18n, availableLocales } = await import('/src/i18n/index.ts');
    i18n.global.setLocaleMessage('de', {
      common: { language: 'Sprache', languageHint: 'Sprache der Benutzeroberfläche', followBrowserLanguage: 'Browsersprache verwenden' },
      settingsDialog: { settings: 'Einstellungen' },
      appSpaces: { settings: 'Einstellungen' },
    });
    availableLocales.push('de');
  });
  await page.locator('.app-spaces__settings').click();
  const dialog = page.locator('[data-settings-dialog]');
  await dialog.locator('.language-picker summary').click();
  await dialog.getByRole('menuitemradio', { name: 'Deutsch', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Einstellungen' })).toBeVisible();
  await expect(dialog.locator('#settings-language-label')).toHaveText('Sprache');
  await expect(dialog.getByRole('button', { name: 'Close settings', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  expect(await page.evaluate(() => localStorage.getItem('stormbox.locale'))).toBe('de');

  await page.screenshot({ path: info.outputPath('language-wide.png') });
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('language-narrow.png') });
  await page.setViewportSize({ width: 1280, height: 800 });

  await dialog.locator('.language-picker summary').focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('menuitemradio', { name: 'Deutsch', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('menuitemradio', { name: 'English', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('stormbox.locale'))).toBe('en');
  await page.reload();
  await expect(page.locator('.shell')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('synchronizes regional language preferences across tabs', async ({ page }) => {
  await loginViaOidc(page);
  const other = await page.context().newPage();
  await other.goto('/');
  await expect(other.locator('.shell')).toBeVisible();
  await page.evaluate(async () => {
    const { setLocalePreference } = await import('/src/i18n/index.ts');
    setLocalePreference('en-GB');
  });
  await expect(other.locator('html')).toHaveAttribute('lang', 'en-GB');
  const date = await other.evaluate(async () => {
    const { formatDate } = await import('/src/i18n/messages.ts');
    return formatDate(Date.UTC(2026, 9, 28), { timeZone: 'UTC' });
  });
  expect(date).toBe('28/10/2026');
  await other.close();
});
