import { test as setup } from '@playwright/test';

import { initializeEmptyAuthStorage, ensureStormboxSignedIn } from '../../utils/auth';

initializeEmptyAuthStorage();

setup('desktop browser authenticate', async ({ page }) => {
  await ensureStormboxSignedIn(page);
});
