import { test as setup } from '@playwright/test';

import { initializeEmptyAuthStorage, ensureStormboxSignedIn } from '../helpers/auth';

initializeEmptyAuthStorage();

setup('desktop browser authenticate', async ({ page }) => {
  await ensureStormboxSignedIn(page);
});
