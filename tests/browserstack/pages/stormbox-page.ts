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
  readonly signInWithThunderbird: Locator;
  readonly thundermailMenu: Locator;
  readonly thundermailMenuButton: Locator;
  readonly appointmentMenuItem: Locator;
  readonly sendMenuItem: Locator;
  readonly quickFilter: Locator;
  readonly newMessageButton: Locator;
  readonly mailboxesNav: Locator;
  readonly mailSpaceButton: Locator;
  readonly contactsSpaceButton: Locator;
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
  readonly showWelcomeModalMenuItem: Locator;
  readonly logOutMenuItem: Locator;
  readonly selectAllMessagesCheckbox: Locator;
  readonly unreadFilterButton: Locator;
  readonly messageCount: Locator;
  readonly messageRefreshButton: Locator;
  readonly loadingInboxMessage: Locator;
  readonly loadingMessageList: Locator;
  readonly composeDialog: Locator;
  readonly discardComposeButton: Locator;
  readonly allContactsHeading: Locator;
  readonly addContactButton: Locator;
  readonly contactNameInput: Locator;
  readonly contactEmailInput: Locator;
  readonly cancelContactButton: Locator;
  readonly welcomeDialog: Locator;
  readonly getStartedButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.shell = page.locator('.shell');
    this.signInWithThunderbird = page.getByRole('button', { name: /sign in with thunderbird/i });
    this.thundermailMenu = page.locator('.app-menu');
    this.thundermailMenuButton = page.locator('.app-menu__button[aria-label="Open Thundermail menu"]');
    this.appointmentMenuItem = page.locator('.app-menu__popover').getByRole('menuitem', { name: /^appointment$/i });
    this.sendMenuItem = page.locator('.app-menu__popover').getByRole('menuitem', { name: /^send$/i });
    this.quickFilter = page.locator('.quick-filter__input');
    this.newMessageButton = page.getByRole('button', { name: /new message/i });
    this.mailboxesNav = page.getByRole('navigation', { name: /mailboxes/i });
    this.mailSpaceButton = page.getByRole('button', { name: /^mail$/i });
    this.contactsSpaceButton = page.getByRole('button', { name: /^contacts$/i });
    this.messagesArea = page.getByRole('region', { name: /^messages$/i });
    this.hideFolderListButton = page.getByRole('button', { name: /^hide folder list$/i });
    this.showFolderListButton = page.getByRole('button', { name: /^show folder list$/i });
    this.reportBugButton = page.getByRole('link', { name: /report a bug/i });
    this.giveFeedbackButton = page.getByRole('link', { name: /give feedback/i });
    this.switchToDarkModeButton = page.getByRole('button', { name: /switch to dark mode/i });
    this.switchToLightModeButton = page.getByRole('button', { name: /switch to light mode/i });
    this.accountMenuButton = page.locator('.account-menu__button[aria-label="Open account menu"]');
    this.accountMenuIdentity = page.locator('.account-menu__identity .account-menu__email');
    this.accountSettingsMenuItem = page.getByRole('menuitem', { name: /account settings/i });
    this.showWelcomeModalMenuItem = page.getByRole('menuitem', { name: /show welcome modal/i });
    this.logOutMenuItem = page.getByRole('menuitem', { name: /log out/i });
    this.selectAllMessagesCheckbox = page.locator('.msg-list__select-all input[type="checkbox"]');
    this.unreadFilterButton = page.getByRole('button', { name: /^unread$/i });
    this.messageCount = page.locator('.msg-list__count');
    this.messageRefreshButton = page.locator('.msg-list__refresh');
    this.loadingInboxMessage = page.locator('.msg-list__loader, .msg-list__placeholder')
      .filter({ hasText: /loading inbox/i });
    this.loadingMessageList = page.locator('.msg-list__loader, .msg-list__placeholder')
      .filter({ hasText: /loading/i });
    this.composeDialog = page.getByRole('dialog', { name: /^compose$/i });
    this.discardComposeButton = page.getByRole('button', { name: /^discard$/i });
    this.allContactsHeading = page.getByRole('heading', { name: /^all contacts$/i });
    this.addContactButton = page.getByRole('button', { name: /^add contact$/i });
    this.contactNameInput = page.locator('.contacts__form input[type="text"]').first();
    this.contactEmailInput = page.locator('.contacts__form input[type="email"]').first();
    this.cancelContactButton = page.locator('.contacts__form').getByRole('button', { name: /^cancel$/i });
    this.welcomeDialog = page.getByRole('dialog', { name: /welcome to thundermail/i });
    this.getStartedButton = page.getByRole('button', { name: /^get started$/i });
  }

  async navigate() {
    expect(STORMBOX_BASE_URL, 'STORMBOX_BASE_URL must be set').toBeTruthy();

    await this.page.addInitScript(() => {
      window.localStorage.setItem('stormbox.welcomeModalDismissed.v1', '1');
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

    await expect(this.signInWithThunderbird).toBeEnabled({ timeout: TIMEOUT_30_SECONDS });
    await this.signInWithThunderbird.click({
      force: projectName.toLowerCase().includes('android'),
    });
    await this.signInToThunderbirdAccount(projectName);
    await this.waitForAppUi();
    await this.waitForInboxToFinishLoading();
  }

  async assertDesktopUiVisible() {
    await this.waitForAppUi();
    await expect(this.thundermailMenu).toBeVisible();
    await expect(this.quickFilter).toBeVisible();
    await expect(this.newMessageButton).toBeVisible();
    await expect(this.mailboxesNav).toBeVisible();
    await expect(this.mailSpaceButton).toBeVisible();
    await expect(this.contactsSpaceButton).toBeVisible();
    await expect(this.messagesArea).toBeVisible();
    await this.assertCommonAuthenticatedUiVisible();

    // on desktop the mail folders are visible by default (and the hide folders button visible)
    await expect(this.hideFolderListButton).toBeVisible();
    await expect(this.showFolderListButton).not.toBeVisible();
  }

  async assertMobileUiVisible() {
    await this.waitForAppUi();
    await expect(this.thundermailMenu).toBeVisible();
    await expect(this.quickFilter).toBeVisible();
    await expect(this.mailSpaceButton).toBeVisible();
    await expect(this.contactsSpaceButton).toBeVisible();
    await expect(this.messagesArea).toBeVisible();
    await this.assertCommonAuthenticatedUiVisible();
  }

  async exerciseCommonUiControls(projectName = 'desktop') {
    await this.exerciseQuickFilter();
    await this.exerciseThemeToggle();
    await this.exerciseMessageListControls();
    await this.exerciseFolderListToggle(projectName);
    await this.exerciseComposeDialog();
    await this.exerciseFolderNavigation();
    await this.exerciseContactsView();
    await this.exerciseWelcomeModal();
    await this.assertExternalLinkOpensInNewTab(this.reportBugButton, BUG_REPORT_URL_PATTERN);
    await this.assertExternalLinkOpensInNewTab(this.giveFeedbackButton, FEEDBACK_URL_PATTERN);
  }

  private async assertCommonAuthenticatedUiVisible() {
    await this.assertThundermailMenuItemsVisible();
    await expect(this.reportBugButton).toBeVisible();
    await expect(this.giveFeedbackButton).toBeVisible();
    await this.assertThemeToggleForCurrentModeVisible();
    await this.assertAccountMenuItemsVisible();
    await expect(this.selectAllMessagesCheckbox).toBeVisible();
    await expect(this.unreadFilterButton).toBeVisible();
    await expect(this.messageCount).toHaveText(/\d+\s+messages?/i, { timeout: TIMEOUT_60_SECONDS });
    await expect(this.messageRefreshButton).toBeVisible();
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

  private async exerciseComposeDialog() {
    if (await this.showFolderListButton.isVisible().catch(() => false)) {
      await this.showFolderList();
    }

    await expect(this.newMessageButton).toBeVisible();
    await this.newMessageButton.click();
    await expect(this.composeDialog).toBeVisible();
    await this.discardComposeButton.click();
    await expect(this.composeDialog).not.toBeVisible();
  }

  private async exerciseFolderNavigation() {
    if (await this.showFolderListButton.isVisible().catch(() => false)) {
      await this.showFolderList();
    }
    await expect(this.mailboxesNav).toBeVisible();

    for (const folderName of FOLDER_NAMES_TO_EXERCISE) {
      await this.clickFolder(folderName);
      await this.page.waitForTimeout(TIMEOUT_2_SECONDS / 2);
    }

    await this.clickFolder('Inbox');
    await this.page.waitForTimeout(TIMEOUT_2_SECONDS / 2);
  }

  private async exerciseContactsView() {
    await expect(this.contactsSpaceButton).toBeVisible();
    await this.contactsSpaceButton.click();
    await expect(this.allContactsHeading).toBeVisible();
    await expect(this.addContactButton).toBeVisible();
    await this.addContactButton.click();
    await expect(this.contactNameInput).toBeVisible();
    await expect(this.contactEmailInput).toBeVisible();
    await this.cancelContactButton.click();
    await expect(this.contactEmailInput).not.toBeVisible();
    await this.mailSpaceButton.click();
    await this.waitForAppUi();
  }

  private async showFolderList() {
    if (await this.showFolderListButton.isVisible().catch(() => false)) {
      await this.showFolderListButton.click();
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
    return projectName.toLowerCase() === 'desktop';
  }

  private escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async assertExternalLinkOpensInNewTab(link: Locator, expectedUrl: RegExp) {
    await expect(link).toBeVisible();

    const popupPromise = this.waitForExternalLinkPage();
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

  private async exerciseThemeToggle() {
    const theme = await this.currentTheme();
    if (theme === 'light') {
      await this.switchToDarkModeButton.click();
      await expect(this.switchToLightModeButton).toBeVisible();
      await this.page.waitForTimeout(TIMEOUT_2_SECONDS / 2);
      await this.switchToLightModeButton.click();
      await expect(this.switchToDarkModeButton).toBeVisible();
      return;
    }

    await this.switchToLightModeButton.click();
    await expect(this.switchToDarkModeButton).toBeVisible();
    await this.page.waitForTimeout(TIMEOUT_2_SECONDS / 2);
    await this.switchToDarkModeButton.click();
    await expect(this.switchToLightModeButton).toBeVisible();
  }

  private async exerciseWelcomeModal() {
    await expect(this.accountMenuButton).toBeVisible();
    await this.accountMenuButton.click();
    await expect(this.showWelcomeModalMenuItem).toBeVisible();
    await this.showWelcomeModalMenuItem.click();
    await expect(this.welcomeDialog).toBeVisible();
    await this.getStartedButton.click();
    await expect(this.welcomeDialog).not.toBeVisible();
  }

  private async assertThundermailMenuItemsVisible() {
    await expect(this.thundermailMenuButton).toBeVisible();
    await this.thundermailMenuButton.click();
    await expect(this.appointmentMenuItem).toBeVisible();
    await expect(this.sendMenuItem).toBeVisible();
    // BrowserStack can hang on a second native details-summary click, so close the menu directly.
    await this.thundermailMenu.evaluate((menu) => {
      if (menu instanceof HTMLDetailsElement) {
        menu.open = false;
      }
    });
  }

  private async assertThemeToggleForCurrentModeVisible() {
    const theme = await this.currentTheme();

    if (theme === 'dark') {
      await expect(this.switchToLightModeButton).toBeVisible();
      return;
    }

    await expect(this.switchToDarkModeButton).toBeVisible();
  }

  private async currentTheme() {
    const theme = await this.page.evaluate(() => document.documentElement.dataset.theme);
    expect(theme, 'Stormbox theme should be set before checking the theme toggle').toMatch(/^(dark|light)$/);
    return theme as 'dark' | 'light';
  }

  private async assertAccountMenuItemsVisible() {
    await expect(this.accountMenuButton).toBeVisible();
    await this.accountMenuButton.click();
    await expect(this.accountMenuIdentity).toHaveText(ACCTS_OIDC_EMAIL);
    await expect(this.accountSettingsMenuItem).toBeVisible();
    await expect(this.showWelcomeModalMenuItem).toBeVisible();
    await expect(this.logOutMenuItem).toBeVisible();
    await this.accountMenuButton.click();
  }

  private async waitForAppUi() {
    await expect(this.thundermailMenu).toBeVisible({ timeout: TIMEOUT_60_SECONDS });
    await expect(this.quickFilter).toBeVisible({ timeout: TIMEOUT_60_SECONDS });
  }

  private async waitForInboxToFinishLoading() {
    await expect(this.loadingInboxMessage).not.toBeVisible({ timeout: TIMEOUT_60_SECONDS });
  }

  private async isAppUiVisible(timeout: number) {
    try {
      await expect(this.thundermailMenu).toBeVisible({ timeout });
      await expect(this.quickFilter).toBeVisible({ timeout });
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
        this.signInWithThunderbird.waitFor({ state: 'visible', timeout }),
        this.thundermailMenu.waitFor({ state: 'visible', timeout }),
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
