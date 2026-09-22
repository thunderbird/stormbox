import { expect, type Locator, type Page } from '@playwright/test';

import {
  FOLDER_NAMES_TO_EXERCISE,
  STORMBOX_BASE_URL,
  ACCTS_OIDC_PWORD,
  ACCTS_OIDC_EMAIL,
  TIMEOUT_2_SECONDS,
  TIMEOUT_10_SECONDS,
  TIMEOUT_30_SECONDS,
  TIMEOUT_60_SECONDS,
} from '../const/constants';

const BUG_REPORT_URL_PATTERN = /^https:\/\/github\.com\/thunderbird\/stormbox\/issues\/?$/;
const FEEDBACK_URL_PATTERN = /^https:\/\/ideas\.tb\.pro\/?$/;
const QUICK_FILTER_EXERCISE_TEXT = 'Thundermail is awesome';

export class StormboxPage {
  readonly page: Page;
  readonly shell: Locator;
  readonly signInButton: Locator;
  readonly thundermailMenu: Locator;
  readonly thundermailMenuButton: Locator;
  readonly compactMenu: Locator;
  readonly compactMenuButton: Locator;
  readonly appointmentMenuItem: Locator;
  readonly sendMenuItem: Locator;
  readonly quickFilter: Locator;
  readonly newMessageButton: Locator;
  readonly mailboxesNav: Locator;
  readonly mailSpaceButton: Locator;
  readonly contactsSpaceButton: Locator;
  readonly showAddressBookListButton: Locator;
  readonly messagesArea: Locator;
  readonly hideFolderListButton: Locator;
  readonly showFolderListButton: Locator;
  readonly reportBugButton: Locator;
  readonly giveFeedbackButton: Locator;
  readonly switchToDarkModeButton: Locator;
  readonly switchToLightModeButton: Locator;
  readonly accountMenuButton: Locator;
  readonly accountMenuIdentity: Locator;
  readonly accountSettingsMenuItem: Locator;
  readonly logOutMenuItem: Locator;
  readonly settingsGearButton: Locator;
  readonly settingsMenuItem: Locator;
  readonly settingsDialog: Locator;
  readonly settingsCloseButton: Locator;
  readonly systemThemeToggle: Locator;
  readonly showWelcomeButton: Locator;
  readonly messageListHeader: Locator;
  readonly selectAllMessagesCheckbox: Locator;
  readonly unreadFilterButton: Locator;
  readonly inboxEmptyText: Locator;
  readonly messageCount: Locator;
  readonly messageRefreshButton: Locator;
  readonly loadingInboxMessage: Locator;
  readonly loadingMessageList: Locator;
  readonly composeDialog: Locator;
  readonly closeComposeButton: Locator;
  readonly allContactsHeading: Locator;
  readonly addContactButton: Locator;
  readonly contactNameInput: Locator;
  readonly contactEmailInput: Locator;
  readonly cancelContactButton: Locator;
  readonly welcomeDialog: Locator;
  readonly getStartedButton: Locator;
  readonly manageFoldersButton: Locator;
  readonly manageFoldersDialog: Locator;
  readonly manageFoldersHdr: Locator;
  readonly manageFoldersText: Locator;
  readonly manageFoldersSearchInput: Locator;
  readonly manageFoldersCloseBtn: Locator;
  readonly manageFoldersExpandBtn: Locator;
  readonly manageFoldersAddTopLevelBtn: Locator;
  readonly manageFoldersNewFolderDialog: Locator;
  readonly manageFoldersNewFolderNameInput: Locator;
  readonly manageFoldersNewFolderParentDropdown: Locator;
  readonly manageFoldersNewFolderCreateBtn: Locator;
  readonly manageFoldersNewFolderCancelBtn: Locator;
  readonly manageFoldersNewFolderNameExistsText: Locator;
  readonly manageFoldersExpandInboxBtn: Locator;
  readonly manageFoldersRenameNameInput: Locator;
  readonly manageFoldersMoveRenameSaveBtn: Locator;
  readonly manageFoldersMoveParentDropdown: Locator;
  readonly foldersPanelExpandInboxBtn: Locator;
  readonly manageFoldersDeleteSelectedFoldersBtn: Locator;
  readonly manageFoldersDialogDeleteNFoldersText: Locator;
  readonly manageFoldersDialogDeleteNFoldersConfirmBtn: Locator;

  constructor(page: Page) {
    this.page = page;
    this.shell = page.locator('.shell');
    this.signInButton = page.locator('.login-card__signin');
    // Desktop keeps the app drawer and the action buttons in the bar; below
    // 640px they collapse into the compact menu's menuitems. Role locators
    // skip hidden elements, so each resolves to the one copy the current
    // layout shows once the right menu is open.
    this.thundermailMenu = page.locator('.app-drawer');
    this.thundermailMenuButton = page.locator('.app-drawer__button[aria-label="Open app drawer"]');
    this.compactMenu = page.locator('.top-nav-menu');
    this.compactMenuButton = page.locator('.top-nav-menu__button[aria-label="Open menu"]');
    this.appointmentMenuItem = page.getByRole('menuitem', { name: /^appointment$/i });
    this.sendMenuItem = page.getByRole('menuitem', { name: /^send$/i });
    this.quickFilter = page.locator('.quick-filter__input');
    this.newMessageButton = page.getByRole('button', { name: /new message/i });
    this.mailboxesNav = page.getByRole('navigation', { name: /mailboxes/i });
    this.mailSpaceButton = page.getByRole('button', { name: /^mail$/i });
    this.contactsSpaceButton = page.getByRole('button', { name: /^contacts$/i });
    this.showAddressBookListButton = page.getByRole('button', { name: /^show address book list$/i });
    this.messagesArea = page.getByRole('region', { name: /^messages$/i });
    this.hideFolderListButton = page.getByRole('button', { name: /^hide folder list$/i });
    this.showFolderListButton = page.getByRole('button', { name: /^show folder list$/i });
    this.reportBugButton = this.headerAction('link', /report a bug/i);
    this.giveFeedbackButton = this.headerAction('link', /give feedback/i);
    this.switchToDarkModeButton = this.headerAction('button', /switch to dark mode/i);
    this.switchToLightModeButton = this.headerAction('button', /switch to light mode/i);
    this.accountMenuButton = page.locator('.account-menu__button[aria-label="Open account menu"]');
    this.accountMenuIdentity = page.locator('.account-menu__identity .account-menu__email');
    this.accountSettingsMenuItem = page.getByRole('menuitem', { name: /account settings/i });
    this.logOutMenuItem = page.getByRole('menuitem', { name: /log out/i });
    this.settingsGearButton = page.locator('[data-settings-gear]');
    this.settingsMenuItem = page.getByRole('menuitem', { name: /^settings$/i });
    this.settingsDialog = page.getByRole('dialog', { name: /^settings$/i });
    this.settingsCloseButton = this.settingsDialog.getByRole('button', { name: /^close settings$/i });
    this.systemThemeToggle = this.settingsDialog.locator('[data-system-theme-toggle]');
    this.showWelcomeButton = this.settingsDialog.getByRole('button', { name: /^show welcome$/i });
    this.messageListHeader = page.locator('.msg-list__header');
    this.selectAllMessagesCheckbox = page.locator('.msg-list__select-all input[type="checkbox"]');
    this.unreadFilterButton = page.getByRole('button', { name: /^unread$/i });
    this.inboxEmptyText = page.getByText('Inbox is empty');
    this.messageCount = page.locator('.msg-list__count');
    this.messageRefreshButton = page.locator('.msg-list__refresh');
    this.loadingInboxMessage = page.locator('.msg-list__loader, .msg-list__placeholder')
      .filter({ hasText: /loading inbox/i });
    this.loadingMessageList = page.locator('.msg-list__loader, .msg-list__placeholder')
      .filter({ hasText: /loading/i });
    this.composeDialog = page.getByRole('dialog', { name: /^new message$/i });
    this.closeComposeButton = this.composeDialog.getByRole('button', { name: /^close$/i });
    this.allContactsHeading = page.getByRole('heading', { name: /^all contacts$/i });
    this.addContactButton = page.getByRole('button', { name: /^new contact$/i });
    this.contactNameInput = page.locator('.contacts__form').getByRole('textbox', { name: /^full or display name$/i });
    this.contactEmailInput = page.locator('.contacts__form').getByRole('textbox', { name: /^email addresses value$/i });
    this.cancelContactButton = page.locator('.contacts__form').getByRole('button', { name: /^cancel$/i });
    this.welcomeDialog = page.getByRole('dialog', { name: /welcome to thundermail/i });
    this.getStartedButton = page.getByRole('button', { name: /^get started$/i });
    this.manageFoldersButton = page.getByRole('button', { name: 'Manage Folders' });
    this.manageFoldersDialog = page.getByRole('dialog', { name: 'Manage Folders' });
    this.manageFoldersHdr = this.manageFoldersDialog.getByRole('heading', { name: 'Manage Folders', level: 2 });
    this.manageFoldersText = this.manageFoldersDialog.getByText('Drag a folder to move it, or select several to delete them');
    this.manageFoldersSearchInput = this.manageFoldersDialog.locator('.folder-subs__search-input');
    this.manageFoldersCloseBtn = this.manageFoldersDialog.getByRole('button', { name: 'Close manage folders' });
    this.manageFoldersExpandBtn = this.manageFoldersDialog.getByRole('button', { name: 'Expand default folders' });
    this.manageFoldersAddTopLevelBtn = this.manageFoldersDialog.getByRole('button', { name: 'New folder', exact: true });
    this.manageFoldersNewFolderDialog = page.getByRole('dialog', { name: 'New folder' });
    this.manageFoldersNewFolderNameInput = this.manageFoldersNewFolderDialog.getByRole('textbox', { name: 'Name' });
    this.manageFoldersNewFolderParentDropdown = this.manageFoldersNewFolderDialog.locator('[data-folder-create-parent]');
    this.manageFoldersNewFolderCreateBtn = this.manageFoldersNewFolderDialog.getByRole('button', { name: 'Create' });
    this.manageFoldersNewFolderCancelBtn = this.manageFoldersNewFolderDialog.getByRole('button', { name: 'Cancel' });
    this.manageFoldersNewFolderNameExistsText = this.manageFoldersNewFolderDialog.getByText('A folder with that name already exists here.', { exact: true });
    this.manageFoldersExpandInboxBtn = this.manageFoldersDialog.getByRole('button', { name: 'Expand inbox' });
    this.manageFoldersRenameNameInput = this.manageFoldersDialog.getByRole('textbox', { name: 'Name' })
    this.manageFoldersMoveParentDropdown = this.manageFoldersDialog.locator('[data-folder-move-select]');
    this.manageFoldersMoveRenameSaveBtn = this.manageFoldersDialog.getByRole('button', { name: 'Save' });
    this.foldersPanelExpandInboxBtn = page.locator('.folder-node')
      .filter({ has: page.getByText('Inbox', { exact: true }) })
      .filter({ has: page.getByRole('button', { name: 'Expand folder' }) })
      .getByRole('button', { name: 'Expand folder' });
    this.manageFoldersDeleteSelectedFoldersBtn = this.manageFoldersDialog.getByRole('button', { name: 'Delete selected folders' });
    this.manageFoldersDialogDeleteNFoldersText = this.manageFoldersDialog.locator('.folder-subs__bulk-confirm');
    this.manageFoldersDialogDeleteNFoldersConfirmBtn = this.manageFoldersDialog.locator('[data-folder-bulk-confirm]');
  }

  /** A bar action on desktop, or the same action as a compact-menu item. */
  private headerAction(barRole: 'link' | 'button', name: RegExp) {
    return this.page.getByRole(barRole, { name })
      .or(this.page.getByRole('menuitem', { name }));
  }

  async navigate() {
    expect(STORMBOX_BASE_URL, 'STORMBOX_BASE_URL must be set').toBeTruthy();

    await this.page.addInitScript(() => {
      window.localStorage.setItem('stormbox.welcomeModalDismissed.v1', '1');
      window.localStorage.setItem('stormbox.whatsNewSeen.2026-09-compose', '1');
    });
    try {
      await this.page.goto(STORMBOX_BASE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT_60_SECONDS,
      });
    } catch (error) {
      if (await this.didBrowserStackTimeoutAfterPageRendered(error)) {
        return;
      }
      throw error;
    }
  }

  // Stormbox requires some specific browser features; check if any are missing in current browser
  async missingRequiredBrowserFeatures() {
    return this.page.evaluate(() => {
      const missing: string[] = [];
      if (typeof globalThis.SharedWorker === 'undefined') missing.push('SharedWorker');
      if (typeof globalThis.BroadcastChannel === 'undefined') missing.push('BroadcastChannel');
      if (typeof globalThis.MessageChannel === 'undefined') missing.push('MessageChannel');
      if (typeof globalThis.indexedDB === 'undefined') missing.push('IndexedDB');
      return missing;
    });
  }

  async signInIfNeeded(projectName = 'desktop') {
    if (await this.isAppUiVisible(TIMEOUT_10_SECONDS)) {
      await this.waitForInboxToFinishLoading();
      return;
    }

    await expect(this.signInButton).toBeEnabled({ timeout: TIMEOUT_30_SECONDS });
    await this.signInButton.click({
      force: projectName.toLowerCase().includes('android'),
    });
    await this.signInToThunderbirdAccount(projectName);
    await this.waitForAppUi();
    await this.waitForInboxToFinishLoading();
  }

  async assertDesktopUiVisible() {
    await this.waitForAppUi();
    await expect(this.thundermailMenu).toBeVisible();
    await expect(this.compactMenuButton).not.toBeVisible();
    await expect(this.quickFilter).toBeVisible();
    await expect(this.newMessageButton).toBeVisible();
    await expect(this.mailboxesNav).toBeVisible();
    await expect(this.mailSpaceButton).toBeVisible();
    await expect(this.contactsSpaceButton).toBeVisible();
    await expect(this.messagesArea).toBeVisible();
    await this.assertCommonAuthenticatedUiVisible('desktop');

    // on desktop the mail folders are visible by default (and the hide folders button visible)
    await expect(this.hideFolderListButton).toBeVisible();
    await expect(this.showFolderListButton).not.toBeVisible();
  }

  async assertMobileUiVisible(projectName = 'mobile') {
    await this.waitForAppUi();
    await expect(this.compactMenuButton).toBeVisible();
    await expect(this.thundermailMenu).not.toBeVisible();
    await expect(this.quickFilter).toBeVisible();
    await expect(this.mailSpaceButton).toBeVisible();
    await expect(this.contactsSpaceButton).toBeVisible();
    await expect(this.messagesArea).toBeVisible();
    await this.assertCommonAuthenticatedUiVisible(projectName);
  }

  async exerciseCommonUiControls(projectName = 'desktop') {
    await this.exerciseQuickFilter();
    await this.exerciseThemeToggle(projectName);
    await this.exerciseMessageListControls();
    await this.exerciseFolderListToggle(projectName);
    await this.exerciseComposeDialog(projectName);
    await this.exerciseFolderNavigation(projectName);
    await this.exerciseManageFoldersDialog(projectName);
    await this.exerciseContactsView(projectName);
    await this.exerciseWelcomeModal(projectName);
    await this.assertExternalLinkOpensInNewTab(this.reportBugButton, BUG_REPORT_URL_PATTERN, projectName);
    await this.assertExternalLinkOpensInNewTab(this.giveFeedbackButton, FEEDBACK_URL_PATTERN, projectName);
  }

  private async assertCommonAuthenticatedUiVisible(projectName: string) {
    await this.assertThundermailMenuItemsVisible(projectName);
    await this.withHeaderActions(projectName, async () => {
      await expect(this.reportBugButton).toBeVisible();
      await expect(this.giveFeedbackButton).toBeVisible();
    });
    await this.assertAccountMenuItemsVisible();
    await expect(this.selectAllMessagesCheckbox).toBeVisible();
    await expect(this.messageListHeader).toBeVisible();
    await expect(this.unreadFilterButton).toBeVisible();
    await expect(this.messageRefreshButton).toBeVisible();
  }

  async openManageFoldersDialog(projectName:string = 'desktop') {
    // first check if the manage folders dialog is already open, if so exit
    if (await this.manageFoldersDialog.isVisible().catch(() => false)) {
      return;
    }

    // first we need the folders list panel if it's not already open 
    if (await this.showFolderListButton.isVisible().catch(() => false)) {
      await this.showFolderList(projectName);
    }
    // then click on manage folders button to open the dialog, and click to expand default folders list
    await this.manageFoldersButton.click();
    await this.manageFoldersExpandBtn.click();
    await expect(this.manageFoldersDialog).toBeVisible();
    await expect(this.manageFoldersHdr).toBeVisible();
  }

  async closeManageFoldersDialog() {
    await this.manageFoldersCloseBtn.click();
    await expect(this.manageFoldersDialog).not.toBeVisible();
  }

  async addFolder(fName: string, parentFolder: string, duplicate:boolean, projectName:string = 'desktop') {
    console.log(`creating folder: '${fName}' in '${parentFolder}'`);
    await this.openManageFoldersDialog(projectName);
    await this.manageFoldersAddTopLevelBtn.scrollIntoViewIfNeeded();
    await this.manageFoldersAddTopLevelBtn.click();
    await expect(this.manageFoldersNewFolderDialog).toBeVisible();

    await this.manageFoldersNewFolderNameInput.fill(fName);

    await this.selectFolderParent(
      this.manageFoldersNewFolderParentDropdown,
      'Parent folder',
      parentFolder,
      projectName,
    );

    // now we have the name and parent set, just click create
    await this.manageFoldersNewFolderCreateBtn.click({ force: projectName.toLowerCase().includes('android')});

    // if adding a folder with a duplicate name, expect the 'folder name exists' error and cancel out
    // otherwise we expect the add new folder dialog to be closed after clicking create
    if (duplicate) {
      await expect(this.manageFoldersNewFolderNameExistsText).toBeVisible();
      await this.manageFoldersNewFolderCancelBtn.click({ force: projectName.toLowerCase().includes('android')});
    } else {
      await expect(this.manageFoldersNewFolderDialog).not.toBeVisible();
    }
  }

  async selectMoveFolderParent(parentFolder: string, projectName = 'desktop') {
    await this.selectFolderParent(
      this.manageFoldersMoveParentDropdown,
      'Move to parent',
      parentFolder,
      projectName,
    );
  }

  async delFoldersWithGivenPrefix(fNamePrefix: string, projectName = 'desktop') {
    // search for all folders with the given prefix and delete them
    const onAndroid = projectName.toLowerCase().includes('android');
    await this.openManageFoldersDialog(projectName);
    await this.manageFoldersSearchInput.fill(fNamePrefix);

    // select them all
    var folderCheckboxes = this.manageFoldersDialog.locator(
      'input[data-folder-select]',
    );

    const folderCount = await folderCheckboxes.count();
    console.log(`found ${folderCount} folders to delete`);

    if (folderCount > 0) {
      await expect(folderCheckboxes.first()).toBeVisible();

      for (let index = 0; index < folderCount; index += 1) {
        const checkbox = folderCheckboxes.nth(index);
        const folderName = await checkbox.getAttribute('data-folder-select');
        console.log(`Ensuring folder is selected for deletion: ${folderName}`);
        await checkbox.check({ force: onAndroid });
      }

      // now we have all the folders selected to delete, so delete them
      console.log(`bulk deleting ${folderCount} folders`);
      await this.manageFoldersDeleteSelectedFoldersBtn.click({ force: onAndroid });
      await this.manageFoldersDialogDeleteNFoldersConfirmBtn.click({ force: onAndroid });
      // wait for the bulkbar to go away (folders deleted)
      await expect(this.manageFoldersDialog.locator('[data-folder-bulkbar]')).toBeHidden({ timeout: 15_000 });
      await this.closeManageFoldersDialog();

      // now let's verify no folders with our prefix exist anymore
      await this.openManageFoldersDialog(projectName);

      await this.manageFoldersSearchInput.fill(fNamePrefix);
      await expect(this.manageFoldersSearchInput).toHaveValue(fNamePrefix);

      const remainingTestFolders = this.manageFoldersDialog.locator(
        `input[data-folder-select^="${fNamePrefix}"]`,
      );

      await expect(remainingTestFolders).toHaveCount(0, {
        timeout: 15_000,
      });
    }

    await this.closeManageFoldersDialog();
  }

  private async exerciseQuickFilter() {
    await expect(this.quickFilter).toBeVisible();
    await this.quickFilter.fill(QUICK_FILTER_EXERCISE_TEXT);
    await expect(this.quickFilter).toHaveValue(QUICK_FILTER_EXERCISE_TEXT);
    await this.page.waitForTimeout(TIMEOUT_2_SECONDS / 2);
    await this.quickFilter.fill('');
    await expect(this.quickFilter).toHaveValue('');
  }

  private async exerciseMessageListControls() {
    const count = await this.currentMessageCount();
    if (count > 0) {
      await expect(this.selectAllMessagesCheckbox).toBeEnabled();
      await this.selectAllMessagesCheckbox.check();
      await this.page.waitForTimeout(TIMEOUT_2_SECONDS / 2);
      await this.selectAllMessagesCheckbox.uncheck();
    }

    await expect(this.unreadFilterButton).toBeVisible();
    await this.unreadFilterButton.click();
    await this.page.waitForTimeout(TIMEOUT_2_SECONDS / 2);
    await this.unreadFilterButton.click();

    await expect(this.messageRefreshButton).toBeVisible();
    await this.messageRefreshButton.click();
    await this.page.waitForTimeout(TIMEOUT_2_SECONDS / 2);
  }

  private async currentMessageCount() {
    if (!await this.messageCount.isVisible().catch(() => false)) {
      return 0;
    }

    const text = await this.messageCount.textContent().catch(() => '');
    const match = text?.match(/\d+/);
    return match ? Number(match[0]) : 0;
  }

  private async exerciseFolderListToggle(projectName: string) {
    if (this.isDesktopProject(projectName)) {
      await this.hideFolderList();
      await this.showFolderList();
      return;
    }

    await this.showFolderList();
    await this.hideFolderList();
  }

  private async exerciseComposeDialog(projectName: string) {
    if (await this.showFolderListButton.isVisible().catch(() => false)) {
      await this.showFolderList(projectName);
    }

    await expect(this.newMessageButton).toBeVisible();
    await this.newMessageButton.click();
    await expect(this.composeDialog).toBeVisible();
    await this.closeComposeButton.click();
    await expect(this.composeDialog).not.toBeVisible();
  }

  private async exerciseFolderNavigation(projectName: string) {
    if (await this.showFolderListButton.isVisible().catch(() => false)) {
      await this.showFolderList(projectName);
    }
    await expect(this.mailboxesNav).toBeVisible();

    for (const folderName of FOLDER_NAMES_TO_EXERCISE) {
      await this.clickFolder(folderName);
      await this.page.waitForTimeout(TIMEOUT_2_SECONDS / 2);
    }

    await this.clickFolder('Inbox');
    await this.page.waitForTimeout(TIMEOUT_2_SECONDS / 2);
  }

  private async exerciseManageFoldersDialog(projectName:string = 'desktop') {
    // open the manage folders dialog (may need to open folders panel first)
    await this.openManageFoldersDialog(projectName);
    await expect(this.manageFoldersText).toBeVisible();
    await expect(this.manageFoldersSearchInput).toBeVisible();

    // verify default folders (we already expanded the folders list in openManageFoldersDialog)
    for (const folderName of FOLDER_NAMES_TO_EXERCISE) {
      await expect(this.page.locator('.folder-subs__name', { hasText: folderName })).toBeVisible();
    }

    // finished, close the manage folders dialog
    await this.closeManageFoldersDialog();
  }

  private async exerciseContactsView(projectName:string = 'desktop') {
    await expect(this.contactsSpaceButton).toBeVisible();
    await this.contactsSpaceButton.click();
    await expect(this.allContactsHeading).toBeVisible();

    // Android's single-column layout keeps New Contact in the hidden address-book sidebar.
    if (projectName.toLowerCase().includes('android')) {
      await expect(this.showAddressBookListButton).toBeVisible();
      await this.showAddressBookListButton.click({ force: true });
    }

    await expect(this.addContactButton).toBeVisible();
    await this.addContactButton.click();
    await expect(this.contactNameInput).toBeVisible();
    await expect(this.contactEmailInput).toBeVisible();
    await this.cancelContactButton.click({ force: projectName.toLowerCase().includes('android')});
    await expect(this.contactEmailInput).not.toBeVisible();
    await this.mailSpaceButton.click();
    await this.waitForAppUi();
  }

  async showFolderList(projectName:string = 'desktop') {
    if (await this.showFolderListButton.isVisible().catch(() => false)) {
      await this.showFolderListButton.click({ force: projectName.toLowerCase().includes('android')} );
    }

    await expect(this.mailboxesNav).toBeVisible();
    await expect(this.hideFolderListButton).toBeVisible();
  }

  private async hideFolderList() {
    if (await this.hideFolderListButton.isVisible().catch(() => false)) {
      await this.hideFolderListButton.click();
    }

    await expect(this.mailboxesNav).not.toBeVisible();
    await expect(this.showFolderListButton).toBeVisible();
  }

  private async clickFolder(folderName: string) {
    const folderButton = this.mailboxesNav.getByRole('button', {
      name: new RegExp(`^${this.escapeRegExp(folderName)}\\b`, 'i'),
    });
    await expect(folderButton).toBeVisible({ timeout: TIMEOUT_30_SECONDS });
    await folderButton.click();
    await expect(this.loadingMessageList).not.toBeVisible({ timeout: TIMEOUT_60_SECONDS });
  }

  private isDesktopProject(projectName: string) {
    return !/(android|mobile)/i.test(projectName);
  }

  private escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async selectFolderParent(
    dropdown: Locator,
    menuName: string,
    parentFolder: string,
    projectName: string,
  ) {
    const menu = dropdown.getByRole('menu', { name: menuName, exact: true });
    if (!await menu.isVisible()) {
      await dropdown.locator('summary').click({
        force: projectName.toLowerCase().includes('android'),
      });
    }

    const option = menu.getByRole('menuitemradio', {
      name: new RegExp(`^\\s*${this.escapeRegExp(parentFolder)}\\s*$`, 'i'),
    });
    await expect(option).toBeVisible();

    if (projectName.toLowerCase().includes('android')) {
      // Android can position compact dropdown options outside the pointer viewport.
      await option.dispatchEvent('click');
      return;
    }

    await option.click();
  }

  private async assertExternalLinkOpensInNewTab(link: Locator, expectedUrl: RegExp, projectName: string) {
    await this.openHeaderActions(projectName);
    await expect(link).toBeVisible();

    const popupPromise = this.waitForExternalLinkPage();
    // A compact-menu item closes the menu on click.
    await link.click();
    const popup = await popupPromise;

    await expect(popup).toHaveURL(expectedUrl, { timeout: TIMEOUT_30_SECONDS });
    await popup.close();
    await this.page.bringToFront().catch(() => undefined);
    await this.waitForAppUi();
  }

  private async waitForExternalLinkPage() {
    return Promise.any([
      this.page.waitForEvent('popup', { timeout: TIMEOUT_30_SECONDS }),
      this.page.context().waitForEvent('page', { timeout: TIMEOUT_30_SECONDS }),
    ]);
  }

  private async exerciseThemeToggle(projectName: string) {
    await this.ensureManualThemeMode(projectName);
    const theme = await this.currentTheme();
    const [toOther, back] = theme === 'light'
      ? [this.switchToDarkModeButton, this.switchToLightModeButton]
      : [this.switchToLightModeButton, this.switchToDarkModeButton];

    await this.clickHeaderAction(projectName, toOther);
    await this.withHeaderActions(projectName, () => expect(back).toBeVisible());
    await this.page.waitForTimeout(TIMEOUT_2_SECONDS / 2);
    await this.clickHeaderAction(projectName, back);
    await this.withHeaderActions(projectName, () => expect(toOther).toBeVisible());
  }

  /**
   * The bug/feedback links and the theme toggle live in the bar on desktop
   * and inside the compact menu below 640px; the menu has to be open for
   * them to be visible there. Restores the closed menu afterwards.
   */
  private async withHeaderActions(projectName: string, run: () => Promise<unknown>) {
    await this.openHeaderActions(projectName);
    await run();
    await this.closeHeaderActions(projectName);
  }

  /** Clicks a header action; a compact-menu item closes the menu itself. */
  private async clickHeaderAction(projectName: string, action: Locator) {
    await this.openHeaderActions(projectName);
    await action.click();
  }

  private async openHeaderActions(projectName: string) {
    if (this.isDesktopProject(projectName)) return;
    await expect(this.compactMenuButton).toBeVisible();
    if (await this.isDetailsOpen(this.compactMenu)) return;
    await this.compactMenuButton.click();
    await expect(this.compactMenu.locator('.top-nav-menu__popover')).toBeVisible();
  }

  private async closeHeaderActions(projectName: string) {
    if (this.isDesktopProject(projectName)) return;
    await this.closeDetails(this.compactMenu);
  }

  private isDetailsOpen(menu: Locator) {
    return menu.evaluate((element) => element instanceof HTMLDetailsElement && element.open);
  }

  // BrowserStack can hang on a second native details-summary click, so menus are closed directly.
  private closeDetails(menu: Locator) {
    return menu.evaluate((element) => {
      if (element instanceof HTMLDetailsElement) {
        element.open = false;
      }
    });
  }

  private async ensureManualThemeMode(projectName: string) {
    // turn off 'follow system theme' setting so that the switch mode button appears
    await this.openSettingsDialog(projectName);
    await expect(this.systemThemeToggle).toBeVisible();

    if (await this.isSystemThemeEnabled()) {
      await this.systemThemeToggle.click();
      await expect(this.systemThemeToggle).toHaveAttribute('aria-checked', 'false');
    }

    await this.closeSettingsDialog();
  }

  private async openSettingsDialog(projectName: string) {
    if (await this.settingsDialog.isVisible().catch(() => false)) {
      return;
    }

    if (this.isDesktopProject(projectName)) {
      await expect(this.settingsGearButton).toBeVisible();
      await this.settingsGearButton.click();
    } else {
      await this.clickHeaderAction(projectName, this.settingsMenuItem);
    }

    await expect(this.settingsDialog).toBeVisible();
  }

  private async closeSettingsDialog() {
    if (!await this.settingsDialog.isVisible().catch(() => false)) {
      return;
    }

    await this.settingsCloseButton.click();
    await expect(this.settingsDialog).not.toBeVisible();
  }

  private async isSystemThemeEnabled() {
    return (await this.systemThemeToggle.getAttribute('aria-checked')) === 'true';
  }

  /** Settings is the gear in the spaces rail on desktop and a compact-menu item below 640px. */
  private async exerciseWelcomeModal(projectName: string) {
    await this.openSettingsDialog(projectName);
    await this.showWelcomeButton.click();
    await expect(this.settingsDialog).not.toBeVisible();
    await expect(this.welcomeDialog).toBeVisible();
    await this.getStartedButton.click();
    await expect(this.welcomeDialog).not.toBeVisible();
  }

  private async assertThundermailMenuItemsVisible(projectName: string) {
    if (this.isDesktopProject(projectName)) {
      await expect(this.thundermailMenuButton).toBeVisible();
      await this.thundermailMenuButton.click();
      await expect(this.appointmentMenuItem).toBeVisible();
      await expect(this.sendMenuItem).toBeVisible();
      await this.closeDetails(this.thundermailMenu);
      return;
    }

    await this.withHeaderActions(projectName, async () => {
      await expect(this.appointmentMenuItem).toBeVisible();
      await expect(this.sendMenuItem).toBeVisible();
    });
  }

  private async currentTheme() {
    const theme = await this.page.evaluate(() => {
      const root = document.documentElement;
      if (root.classList.contains('dark')) return 'dark';
      if (root.classList.contains('light')) return 'light';
      if (root.style.colorScheme === 'dark' || root.style.colorScheme === 'light') {
        return root.style.colorScheme;
      }
      return null;
    });
    expect(theme, 'Stormbox theme should be set before checking the theme toggle').toMatch(/^(dark|light)$/);
    return theme as 'dark' | 'light';
  }

  private async assertAccountMenuItemsVisible() {
    await expect(this.accountMenuButton).toBeVisible();
    await this.accountMenuButton.click();
    await expect(this.accountMenuIdentity).toHaveText(ACCTS_OIDC_EMAIL);
    await expect(this.accountSettingsMenuItem).toBeVisible();
    await expect(this.logOutMenuItem).toBeVisible();
    await this.accountMenuButton.click();
  }

  // Readiness keys on controls present in both layouts.
  private async waitForAppUi() {
    await expect(this.accountMenuButton).toBeVisible({ timeout: TIMEOUT_60_SECONDS });
    await expect(this.quickFilter).toBeVisible({ timeout: TIMEOUT_60_SECONDS });
  }

  private async waitForInboxToFinishLoading() {
    await expect(this.loadingInboxMessage).not.toBeVisible({ timeout: TIMEOUT_60_SECONDS });
  }

  private async isAppUiVisible(timeout: number) {
    try {
      await expect(this.accountMenuButton).toBeVisible({ timeout });
      await expect(this.quickFilter).toBeVisible({ timeout });
      return true;
    } catch {
      return false;
    }
  }

  private async isInboxEmptyTextVisible(timeout: number) {
    try {
      await expect(this.inboxEmptyText).toBeVisible({ timeout });
      return true;
    } catch {
      return false;
    }
  }

  // BrowserStack can time out the goto event even after the login gate or app UI has rendered.
  private async didBrowserStackTimeoutAfterPageRendered(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/browserstack_error: Timed out waiting for event|page\.goto:.*timed out/i.test(message)) {
      return false;
    }

    return this.isLoginGateOrAppUiVisible(TIMEOUT_10_SECONDS);
  }

  private async isLoginGateOrAppUiVisible(timeout: number) {
    try {
      await Promise.race([
        this.signInButton.waitFor({ state: 'visible', timeout }),
        this.accountMenuButton.waitFor({ state: 'visible', timeout }),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  private async signInToThunderbirdAccount(projectName: string) {
    expect(ACCTS_OIDC_EMAIL, 'ACCTS_OIDC_EMAIL must be set').toBeTruthy();
    expect(ACCTS_OIDC_PWORD, 'ACCTS_OIDC_PWORD must be set').toBeTruthy();

    const username = this.page.locator(
      '[data-testid="username-input"], input#username, input[name="username"], input[name="email"], input[type="email"]',
    ).first();
    const password = this.page.locator(
      '[data-testid="password-input"], input#password, input[name="password"], input[type="password"]',
    ).first();

    await expect(username).toBeVisible({ timeout: TIMEOUT_60_SECONDS });
    await username.fill(ACCTS_OIDC_EMAIL);
    await expect(password).toBeVisible({ timeout: TIMEOUT_30_SECONDS });
    await password.fill(ACCTS_OIDC_PWORD);
    await this.submitThunderbirdAccountSignIn(projectName);
  }

  private async submitThunderbirdAccountSignIn(projectName: string) {
    await this.page.getByRole('button', { name: /^sign in$/i }).click({
      force: projectName.toLowerCase().includes('android'),
    });
  }

}
