import fs from 'fs';
import path from 'path';

import { type Page } from '@playwright/test';

import { StormboxPage } from '../pages/stormbox-page';

export const authFile = path.join(__dirname, '../test-results/.auth/user.json');

export function initializeEmptyAuthStorage() {
  try {
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, JSON.stringify({}, null, 2));
  } catch (error) {
    throw new Error(`Failed to initialize auth storage file at ${authFile}`, { cause: error });
  }
}

export async function navigateToStormboxAndSignIn(page: Page) {
  const stormbox = new StormboxPage(page);
  await stormbox.navigate();
  await stormbox.signInIfNeeded();
  return stormbox;
}

export async function ensureStormboxSignedIn(page: Page) {
  const stormbox = await navigateToStormboxAndSignIn(page);
  await page.context().storageState({ path: authFile });
  return stormbox;
}
