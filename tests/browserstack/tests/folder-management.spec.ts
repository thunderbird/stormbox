import { test, expect } from '@playwright/test';

import {
  PLAYWRIGHT_TAG_DESKTOP,
  PLAYWRIGHT_TAG_MOBILE,
} from '../const/constants';

import { deleteFoldersByPrefix } from '../helpers/jmap-client';

import { StormboxPage } from '../pages/stormbox-page';


let stormbox: StormboxPage;
let mobile: boolean = false;
const fNamePrefix: string = `E2E-${Date.now()}`;

test.describe('stormbox folder management', {
  tag: [PLAYWRIGHT_TAG_DESKTOP, PLAYWRIGHT_TAG_MOBILE],
}, () => {
  test.beforeEach(async ({ page }, testInfo) => {
    stormbox = new StormboxPage(page);
    mobile = testInfo.project.name.toLowerCase().includes('android');
    await stormbox.navigate();

    // make sure browser has required dependencies; i.e. sharedworker is supported on Android Chrome 148+ only
    const missing = await stormbox.missingRequiredBrowserFeatures();
    test.skip(
      missing.length > 0,
      `Stormbox cannot run in this mobile browser. Missing: ${missing.join(', ')}.`,
    );

    // ensure app is booted and signed in (on mobile we need to sign in each time, desktop uses auth.desktop and saves context)
    await stormbox.signInIfNeeded(testInfo.project.name);

    // The BrowserStack-only JMAP client connects directly to the deployed
    // stage or production Thundermail account with its app password. Remove
    // orphaned test folders before exercising the UI with a clean account.
    console.log('deleting any folders leftover from previous test runs');
    const deletedFolderCount = await deleteFoldersByPrefix('E2E-');
    console.log(`deleted ${deletedFolderCount} folder(s) leftover from previous test runs`);
  });

  test('add, rename, move, search, and delete folders', async ({ page }, testInfo) => {
    const onAndroid:boolean = testInfo.project.name.toLowerCase().includes('android');

    await test.step('add folder (top-level)', async () => {
      await stormbox.openManageFoldersDialog(testInfo.project.name);
      const fName: string = `${fNamePrefix}-A`;
      await stormbox.addFolder(fName, 'Top Level', false, testInfo.project.name);

      await expect(
        page.locator('.folder-subs__name').getByText(fName, { exact: true })
      ).toBeVisible()

      await stormbox.closeManageFoldersDialog();
    });

    await test.step('add folder (inbox subfolder)', async () => {
      await stormbox.openManageFoldersDialog(testInfo.project.name);
      const fName:string = `${fNamePrefix}-SUB`;
      await stormbox.addFolder(fName, 'Inbox', false, testInfo.project.name);
      // now we need to expand the Inbox folder to see the new subfolder
      await stormbox.manageFoldersExpandInboxBtn.click();

      await expect(
        page.locator('.folder-subs__name').getByText(fName, { exact: true })
      ).toBeVisible();

      await stormbox.closeManageFoldersDialog();
    });

    await test.step('add multiple subfolders (one level)', async () => {
      await stormbox.openManageFoldersDialog(testInfo.project.name);
      // add new top-level folder
      const ourTopFolder:string = `${fNamePrefix}-MULTI`;
      await stormbox.addFolder(ourTopFolder, 'Top Level', false, testInfo.project.name);

      // now add a bunch of subfolders inside that one, all the same level
      const numSubFolders = 5;
      var subFoldersCreated: Array<string> = [];
      for (let subNum = 1; subNum <= numSubFolders; subNum += 1) {
        const nextFolder: string = `${fNamePrefix}-SUB-${subNum.toString().padStart(2, '0')}`;
        await stormbox.addFolder(nextFolder, ourTopFolder, false, testInfo.project.name);
        subFoldersCreated.push(nextFolder);
      }

      // close the manage folders dialog, and verify all the new folders exist in the folders panel
      await stormbox.closeManageFoldersDialog();

      // open the folders panel if it's not already open (on mobile it will have been closed)
      await stormbox.showFolderList(testInfo.project.name);

      // click on the new top-level folder on folders panel to expand it so we can see all the new subfolders
      const folder = page.locator('.folder-node').filter({
        has: page.getByText(ourTopFolder, { exact: true }),
      });
      await folder.getByRole('button', { name: 'Expand folder' }).click();

      for (const nextSub of subFoldersCreated) {
        const subFolderLocator = page.locator('.folder-node').filter({
          has: page.getByText(nextSub, { exact: true }),
        });
        await expect(subFolderLocator).toBeVisible();
      }
    });

    await test.step('add multiple subfolder levels', async () => {
      await stormbox.openManageFoldersDialog(testInfo.project.name);
      // add new top-level folder
      const ourTopFolder:string = `${fNamePrefix}-LVL-01`;
      await stormbox.addFolder(ourTopFolder, 'Top Level', false, testInfo.project.name);
      var lvlFoldersCreated: Array<string> = [];
      lvlFoldersCreated.push(ourTopFolder);

      // now add a bunch of subfolders, each one inside the previous one to have multiple levels
      const numSubFolderLevels = 4;
      var lastFolderAdded = ourTopFolder;

      for (let subNum = 1; subNum <= numSubFolderLevels; subNum += 1) {
        const nextFolder: string = `${fNamePrefix}-LVL-${(subNum +1).toString().padStart(2, '0')}`;
        await stormbox.addFolder(nextFolder, lastFolderAdded, false, testInfo.project.name);
        lvlFoldersCreated.push(nextFolder);
        lastFolderAdded = nextFolder;
      }

      // close the manage folders dialog, and verify all the new folders exist in the folders panel
      await stormbox.closeManageFoldersDialog();

      // open the folders panel if it's not already open (on mobile it will have been closed)
      await stormbox.showFolderList(testInfo.project.name);

      // now click through each of our folder levels and verify they all exist
      for (const nextLvl of lvlFoldersCreated) {
        const subFolderLocator = page.locator('.folder-node').filter({
          has: page.getByText(nextLvl, { exact: true }),
        });
        await expect(subFolderLocator).toBeVisible();

        // the last subfolder won't have an expand button
        if (nextLvl != lvlFoldersCreated.at(-1)) {
          await subFolderLocator.getByRole('button', { name: 'Expand folder' }).click({ force: onAndroid });
        }
      }
    });

    await test.step('rename folder', async () => {
      await stormbox.openManageFoldersDialog(testInfo.project.name);

      // create a new top-level folder
      const origFName: string = `${fNamePrefix}-rename-me`;
      await stormbox.addFolder(origFName, 'Top Level', false, testInfo.project.name);

      await expect(
        page.locator('.folder-subs__name').getByText(origFName, { exact: true })
      ).toBeVisible()

      // rename and verify
      const newFName = `${origFName}-RENAMED`;
      console.log(`renaming folder '${origFName}' to '${newFName}'`);
      await page.getByRole(
        'button',
        { name: `Edit folder ${origFName}` }).click({ force: onAndroid }
      );

      await stormbox.manageFoldersMoveRenameSaveBtn.scrollIntoViewIfNeeded();
      await stormbox.manageFoldersRenameNameInput.fill(newFName);
      await stormbox.manageFoldersMoveRenameSaveBtn.click({ force: onAndroid });

      await expect(
        page.locator('.folder-subs__name').getByText(origFName, { exact: true })
      ).not.toBeVisible();

      await expect(
        page.locator('.folder-subs__name').getByText(newFName, { exact: true })
      ).toBeVisible();

      await stormbox.closeManageFoldersDialog();
    });

    await test.step('search for a folder', async () => {
      await stormbox.openManageFoldersDialog(testInfo.project.name);

      // create a new top-level folder then search for it
      const folderNameToFind: string = `${fNamePrefix}-find-me`;
      await stormbox.addFolder(folderNameToFind, 'Top Level', false, testInfo.project.name);

      await expect(
        page.locator('.folder-subs__name').getByText(folderNameToFind, { exact: true })
      ).toBeVisible();

      console.log(`searching for folder: ${folderNameToFind}`);
      await stormbox.manageFoldersSearchInput.fill(folderNameToFind);
      await expect(
        page.locator('.folder-subs__name').getByText(folderNameToFind, { exact: true })
      ).toBeVisible();
      await stormbox.closeManageFoldersDialog();
    });

    await test.step('star a folder', async () => {
      await stormbox.openManageFoldersDialog(testInfo.project.name);
      const fName: string = `${fNamePrefix}-STAR`;
      await stormbox.addFolder(fName, 'Top Level', false, testInfo.project.name);

      await expect(
        page.locator('.folder-subs__name').getByText(fName, { exact: true })
      ).toBeVisible();

      const starButton = page.locator(`[data-folder-star="${fName}"]`);

      // the folder is new so shouldn't be starred yet
      await expect(starButton).toHaveAttribute('aria-pressed', 'false');

      // star it and verify
      console.log(`starring folder: ${fName}`);
      await starButton.click();
      await expect(starButton).toHaveAttribute('aria-pressed', 'true');

      // now close the manage folders dialog and then verify on folder panel our starred folder is first in the list
      // we look for the first folder after the 'Folders' heading so we don't get the system folders by mistate
      await stormbox.closeManageFoldersDialog();

      // need the folders panel open (on mobile it may be closed)
      if (await stormbox.showFolderListButton.isVisible().catch(() => false)) {
        await stormbox.showFolderList(testInfo.project.name);
      }

      // verify folder is now in favorites group/starred
      await expect(
        page.locator('.folder-node[data-tour="folder-favorites"]').filter({ hasText: fName }),
      ).toBeVisible();
    });

    await test.step('move a folder', async () => {
      await stormbox.openManageFoldersDialog(testInfo.project.name);
      // create a new top-level folder
      const fName: string = `${fNamePrefix}-MOVE`;
      await stormbox.addFolder(fName, 'Top Level', false, testInfo.project.name);

      // verify exists on main folders panel
      await stormbox.closeManageFoldersDialog();
      await stormbox.showFolderList(testInfo.project.name);
      const folderLocator = page.locator('.folder-node').filter({
        has: page.getByText(fName, { exact: true }),
      });
      await expect(folderLocator).toBeVisible();

      // move the new folder under the Inbox
      console.log(`moving top-level folder ${fName} to be under the inbox`);
      await stormbox.openManageFoldersDialog(testInfo.project.name);
      const folderEditBtn = page.getByRole('button', {
        name: `Edit folder ${fName}`,
        exact: true,
      });

      await folderEditBtn.click({ force: onAndroid });
      await stormbox.manageFoldersMoveRenameSaveBtn.scrollIntoViewIfNeeded();
      await stormbox.selectMoveFolderParent('Inbox', testInfo.project.name);
      await stormbox.manageFoldersMoveRenameSaveBtn.click({ force: onAndroid });
      await stormbox.closeManageFoldersDialog();

      // verify new folder is now not visible (because it's under Inbox which is not expanded)
      await stormbox.showFolderList(testInfo.project.name);
      await expect(folderLocator).not.toBeVisible();

      // expand Inbox folder and verify folder is now under there
      await stormbox.foldersPanelExpandInboxBtn.click({ force: onAndroid });
      await expect(folderLocator).toBeVisible();
    });
  });

  test.afterEach('delete folders', async ({ page }, testInfo) => {
    // let's delete all the folders this test has created; will only run once (NOT after each test.step)
    console.log('test clean-up: deleting all folders the test created');
    await stormbox.delFoldersWithGivenPrefix(fNamePrefix, testInfo.project.name);
  });
});
