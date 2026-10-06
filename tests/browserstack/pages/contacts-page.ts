import { expect, type Locator, type Page } from '@playwright/test';

import {
  ACCTS_OIDC_EMAIL,
  PRIMARY_THUNDERMAIL_EMAIL,
} from '../const/constants';
import { StormboxPage } from './stormbox-page';

export const CONTACT_PREFIX = 'E2E-Contact';
export const BOOK_PREFIX = 'E2E-AddressBook';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

export interface ContactCreateFields {
  name: string;
  homeEmail: string;
  phone: string;
  website: string;
  birthday: string;
  note: string;
  organization: string;
  department: string;
  title: string;
  role: string;
}

export interface ContactEditFields {
  name: string;
  workEmail: string;
  phone: string;
  website: string;
  weddingDate: string;
  note: string;
  title: string;
}

export interface ExpectedContactDetails extends ContactCreateFields {
  photo: 'png' | 'gif';
  workEmail?: string;
  weddingDate?: string;
  absent?: string[];
}

/** Contacts UI interactions for both the desktop panes and Android's single column. */
export class ContactsPage {
  private readonly page: Page;
  private readonly stormbox: StormboxPage;
  private readonly projectName: string;
  private readonly onAndroid: boolean;
  private readonly onBrowserStackAndroid: boolean;

  readonly contactsView: Locator;
  readonly sidebar: Locator;
  readonly rail: Locator;
  readonly list: Locator;
  readonly listHeading: Locator;
  readonly listNotice: Locator;
  readonly contactForm: Locator;
  readonly contactDetails: Locator;
  readonly bookForm: Locator;
  readonly bookDetails: Locator;
  readonly confirmationDialog: Locator;

  constructor(page: Page, stormbox: StormboxPage, projectName: string) {
    this.page = page;
    this.stormbox = stormbox;
    this.projectName = projectName;
    this.onAndroid = projectName.toLowerCase().includes('android');
    this.onBrowserStackAndroid = projectName === 'android-chrome';
    this.contactsView = page.locator('.contacts');
    this.sidebar = page.locator('.sidebar-slot');
    this.rail = page.getByRole('navigation', { name: 'Address books' });
    this.list = page.locator('.directory-shell__list');
    this.listHeading = page.locator('.directory-list__header h2');
    this.listNotice = page.locator('.directory-list__notice');
    this.contactForm = page.locator('.contact-detail__editor');
    this.contactDetails = page.locator('.contact-detail__body');
    this.bookForm = page.locator('.address-book-detail__editor');
    this.bookDetails = page.locator('.address-book-detail__body');
    this.confirmationDialog = page.getByRole('alertdialog');
  }

  /** The BrowserStack device needs forced taps; the local viewport uses actionability checks. */
  private async tap(target: Locator): Promise<void> {
    await expect(target).toBeVisible();
    await target.click({ force: this.onBrowserStackAndroid });
  }

  contactRow(name: string): Locator {
    return this.page.locator('.contacts__row').filter({
      has: this.page.locator('.directory-list__row-content .name')
        .getByText(name, { exact: true }),
    });
  }

  bookButton(name: string): Locator {
    return this.page.locator('.contacts-rail__book').filter({
      has: this.page.locator('.contacts-rail__name')
        .getByText(name, { exact: true }),
    });
  }

  private detailValue(heading: string, label: string): Locator {
    return this.contactDetails.locator('section').filter({
      has: this.page.getByRole('heading', { name: heading, exact: true }),
    }).locator('dt').filter({ hasText: new RegExp(`^${label}$`) })
      .locator('xpath=following-sibling::dd[1]');
  }

  private resourceRows(kind: 'email' | 'phone' | 'website'): Locator {
    const addLabel = { email: 'Add email', phone: 'Add phone', website: 'Add website' }[kind];
    return this.contactForm.locator('fieldset.contact-resource')
      .filter({ has: this.page.getByRole('button', { name: addLabel, exact: true }) })
      .locator('.contact-resource__row');
  }

  private async chooseResourceLabel(row: Locator, kind: string, label: string): Promise<void> {
    const summary = row.getByLabel(new RegExp(`^Choose ${kind} label`));
    await this.chooseFormMenuItem(summary, label);
    await expect(summary).toHaveAttribute('aria-label', new RegExp(`current label ${label}$`));
  }

  /** Open an editor dropdown before choosing an item from its visible menu. */
  private async chooseFormMenuItem(summary: Locator, label: string): Promise<void> {
    const dropdown = summary.locator('xpath=parent::details');
    if (this.onAndroid) {
      // The keyboard and editor scroll can move the menu after an input is filled.
      await this.positionAndroidFormControl(summary, 0.3);
      await summary.click();
    } else {
      await this.tap(summary);
    }
    await expect(dropdown).toHaveAttribute('open', '');
    const option = dropdown.getByRole('menuitemradio', { name: label, exact: true });
    if (this.onAndroid) {
      await option.click();
    } else {
      await this.tap(option);
    }
  }

  /** The filter change awaits the Contacts navigation guard before Vue applies it. */
  async filter(value: string): Promise<void> {
    await this.stormbox.quickFilter.fill(value);
    if (value) {
      await expect(this.stormbox.quickFilter).not.toHaveClass(/quick-filter__input--empty/);
    } else {
      await expect(this.stormbox.quickFilter).toHaveClass(/quick-filter__input--empty/);
    }
    // Android unmounts the list while showing a detail pane.
    if (await this.list.isVisible()) {
      await expect(this.page.locator('.directory-list__viewport'))
        .toHaveAttribute('aria-busy', 'false');
    }
    if (this.onAndroid) {
      // Android's keyboard can cover the bottom drawer toggle after filtering.
      await this.stormbox.quickFilter.blur();
      await expect(this.stormbox.quickFilter).not.toBeFocused();
      await this.waitForAndroidVisibleControl(this.page.getByRole('button', {
        name: /^(show|hide) address book list$/i,
      }));
    }
  }

  /** Android controls must fit inside the settled screen and editor viewports. */
  private async waitForAndroidVisibleControl(target: Locator): Promise<void> {
    let previous: {
      height: number;
      offsetTop: number;
      targetTop: number;
      targetBottom: number;
    } | null = null;
    let stableSince = Date.now();
    await expect.poll(async () => {
      const geometry = await target.evaluate((element) => {
        const viewport = window.visualViewport;
        const height = viewport?.height ?? window.innerHeight;
        const offsetTop = viewport?.offsetTop ?? 0;
        const bounds = element.getBoundingClientRect();
        const editorBounds = element.closest('.contact-detail__editor')?.getBoundingClientRect();
        return {
          height,
          offsetTop,
          visibleTop: Math.max(offsetTop, editorBounds?.top ?? offsetTop),
          visibleBottom: Math.min(offsetTop + height, editorBounds?.bottom ?? offsetTop + height),
          targetTop: bounds.top,
          targetBottom: bounds.bottom,
        };
      });
      const now = Date.now();
      if (!previous || Math.abs(geometry.height - previous.height) > 1
        || Math.abs(geometry.offsetTop - previous.offsetTop) > 1
        || Math.abs(geometry.targetTop - previous.targetTop) > 1
        || Math.abs(geometry.targetBottom - previous.targetBottom) > 1) {
        stableSince = now;
      }
      previous = geometry;
      return geometry.targetTop >= geometry.visibleTop + 1
        && geometry.targetBottom <= geometry.visibleBottom - 1
        && now - stableSince >= 200;
    }, { timeout: 10_000, intervals: [100] }).toBe(true);
  }

  private async positionAndroidFormControl(target: Locator, position: number): Promise<void> {
    // The editor scrolls independently of the page on Android.
    await this.page.evaluate(() => {
      const focused = document.activeElement;
      if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
        focused.blur();
      }
    });
    await target.evaluate((element, fraction) => {
      const editor = element.closest<HTMLElement>('.contact-detail__editor');
      if (!editor) throw new Error('Control must belong to the contact editor');
      const bounds = element.getBoundingClientRect();
      const editorBounds = editor.getBoundingClientRect();
      editor.scrollTop += bounds.top - editorBounds.top
        - (editor.clientHeight - bounds.height) * fraction;
    }, position);
    await this.waitForAndroidVisibleControl(target);
  }

  private async tapFormAdd(name: string): Promise<void> {
    const button = this.contactForm.getByRole('button', { name, exact: true });
    if (this.onAndroid) {
      await this.positionAndroidFormControl(button, 0.5);
      // Require the button to receive the click; a forced click can silently hit an overlay.
      await button.click();
      return;
    }
    await this.tap(button);
  }

  private async formattedDate(isoDate: string): Promise<string> {
    // Read the browser's locale; UTC noon keeps the calendar day stable.
    return this.page.evaluate((iso) => {
      const [year, month, day] = iso.split('-').map(Number);
      const date = new Date(Date.UTC(year, month - 1, day, 12));
      return new Intl.DateTimeFormat(undefined, {
        day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
      }).format(date);
    }, isoDate);
  }

  /** Check the signed-in OIDC email before opening Contacts. */
  async open(): Promise<void> {
    expect(ACCTS_OIDC_EMAIL, 'ACCTS_OIDC_EMAIL must identify the BrowserStack UI account')
      .toBeTruthy();
    await expect(this.stormbox.accountMenuIdentity).toHaveText(ACCTS_OIDC_EMAIL);
    await this.tap(this.stormbox.contactsSpaceButton);
    await expect(this.contactsView).toBeVisible({ timeout: 30_000 });
    await expect(this.stormbox.quickFilter).toBeVisible();
    await this.filter('');
  }

  async reloadAndOpen(): Promise<void> {
    await this.page.reload();
    // Android restores the current context's OIDC session without another sign-in.
    if (this.onAndroid) {
      await this.stormbox.waitForSignedInApp();
    } else {
      await this.stormbox.signInIfNeeded(this.projectName);
    }
    await this.open();
  }

  /** Android replaces the list with a detail pane; desktop keeps both visible. */
  private async openList(): Promise<void> {
    // Android's rail drawer covers the detail Back button until it is closed.
    await this.closeRailOnPhone();
    const back = this.page.locator(
      '.contact-detail__header button[aria-label="Back"], '
      + '.address-book-detail__header button[aria-label="Back"], '
      + '.trash-detail__header button[aria-label="Back"]',
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await this.list.isVisible()) return;
      // A book detail can sit on top of a contact detail on Android.
      await this.tap(back);
    }
    await expect(this.list).toBeVisible();
  }

  /** Android's translated rail is inert while hidden; isVisible alone is insufficient. */
  async openRail(): Promise<void> {
    if (await this.sidebar.getAttribute('aria-hidden') === 'false') return;
    await this.tap(this.stormbox.showAddressBookListButton);
    await expect(this.sidebar).toHaveAttribute('aria-hidden', 'false');
    await expect(this.rail).toBeVisible();
  }

  private async closeRailOnPhone(): Promise<void> {
    if (await this.page.locator('.directory-shell').getAttribute('data-layout') !== 'phone') {
      return;
    }
    // The Android drawer covers the list until the space-rail toggle closes it.
    const hide = this.page.getByRole('button', { name: 'Hide address book list' });
    if (await hide.isVisible()) {
      await this.tap(hide);
      await expect(this.sidebar).toHaveAttribute('aria-hidden', 'true');
    }
  }

  private async selectRailBook(name: string): Promise<void> {
    await this.openList();
    await this.openRail();
    const button = this.bookButton(name);
    // Scroll long rails first; on phones, aria-hidden changes before the drawer settles.
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport({ ratio: 1 });
    await this.tap(button);
    await this.closeRailOnPhone();
    await expect(this.listHeading).toHaveText(name);
    await expect(this.page.getByRole('listbox', { name, exact: true }))
      .toHaveAttribute('aria-busy', 'false');
  }

  async displayAllContacts(): Promise<void> {
    await this.selectRailBook('All contacts');
  }

  async selectTrash(): Promise<void> {
    await this.selectRailBook('Trash');
  }

  async selectBook(name: string): Promise<void> {
    await this.selectRailBook(name);
  }

  /** Check that the Primary identity has the configured address. */
  async assertExpectedPrimaryMailIdentityVisible(): Promise<void> {
    const expectedEmail = PRIMARY_THUNDERMAIL_EMAIL.trim();
    console.log('verifying primary identity matches PRIMARY_THUNDERMAIL_EMAIL');
    expect(expectedEmail, 'PRIMARY_THUNDERMAIL_EMAIL must contain the expected primary identity')
      .toBeTruthy();
    await this.selectRailBook('Identities');
    await this.filter(expectedEmail);
    const listbox = this.page.getByRole('listbox', { name: 'Identities', exact: true });
    const rows = listbox.locator('.contacts__row');
    const primaryIdentityRow = rows.filter({
      has: this.page.locator('.directory-list__primary-badge')
        .getByText('Primary', { exact: true }),
    });
    // Duplicate addresses can place the Primary identity outside the virtualized rows.
    await listbox.evaluate((element) => { element.scrollTop = 0; });
    await expect(rows.first()).toHaveAttribute('data-index', '0');
    const totalRows = Number(await rows.first().getAttribute('aria-setsize'));
    const rowHeight = await rows.first().evaluate((element) => element.getBoundingClientRect().height);
    while (await primaryIdentityRow.count() === 0) {
      const lastIndex = Number(await rows.last().getAttribute('data-index'));
      if (lastIndex >= totalRows - 1) {
        throw new Error(`No Primary identity appears for ${expectedEmail}`);
      }
      // Move at least one measured row even when the Android keyboard shortens the viewport.
      await listbox.evaluate((element, minimumStep) => {
        element.scrollTop += Math.max(minimumStep, Math.floor(element.clientHeight / 2));
      }, Math.ceil(rowHeight) + 1);
      await expect.poll(async () => Number(await rows.last().getAttribute('data-index')))
        .toBeGreaterThan(lastIndex);
    }
    await expect(primaryIdentityRow).toHaveCount(1);
    await expect(primaryIdentityRow).toBeVisible();
    await expect(primaryIdentityRow.locator('.directory-list__row-content .email'))
      .toHaveText(expectedEmail);
    await this.filter('');
    await this.displayAllContacts();
  }

  /** New contacts inherit the currently selected address book. */
  private async beginContact(name: string, email: string): Promise<void> {
    await this.openList();
    await this.openRail();
    await this.tap(this.stormbox.addContactButton);
    // Android opens the form behind the rail drawer; desktop has a separate sidebar.
    await this.closeRailOnPhone();
    await expect(this.contactForm).toBeVisible();
    await this.contactForm.getByRole('textbox', { name: 'Full or display name' }).fill(name);
    await this.contactForm.getByRole('textbox', { name: 'Email addresses value' }).fill(email);
  }

  private async saveContact(name: string): Promise<void> {
    await this.tap(this.contactForm.getByRole('button', { name: 'Save contact' }));
    await expect(this.contactForm).toBeHidden({ timeout: 30_000 });
    await expect(this.page.locator('.contact-detail__display-name')).toHaveText(name);
  }

  private async uploadPhoto(kind: 'png' | 'gif'): Promise<void> {
    // Tiny in-memory fixtures keep the upload independent of host file paths.
    const base64 = kind === 'png' ? PNG_BASE64 : GIF_BASE64;
    await this.contactForm.locator('.contact-detail__photo-input').setInputFiles({
      name: `contact.${kind}`,
      mimeType: `image/${kind}`,
      buffer: Buffer.from(base64, 'base64'),
    });
    await expect(this.contactForm.locator('.contact-detail__photo-editor img'))
      .toHaveAttribute('src', `data:image/${kind};base64,${base64}`);
  }

  async createBasicContact(name: string, email: string): Promise<void> {
    await this.beginContact(name, email);
    await this.saveContact(name);
  }

  /** Fill the complete create form through its labeled controls. */
  async createDetailedContact(fields: ContactCreateFields): Promise<void> {
    console.log(`creating contact: ${fields.name}`);
    await this.beginContact(fields.name, fields.homeEmail);
    const home = this.resourceRows('email').first();
    await this.chooseResourceLabel(home, 'email', 'Home');
    await expect(home.getByRole('button', { name: 'Primary' }))
      .toHaveAttribute('aria-pressed', 'true');

    await this.tapFormAdd('Add phone');
    const phone = this.resourceRows('phone').first();
    await expect(phone).toBeVisible();
    await phone.getByLabel('Phone numbers value').fill(fields.phone);
    await this.chooseResourceLabel(phone, 'phone', 'Work');

    await this.tapFormAdd('Add website');
    const website = this.resourceRows('website').first();
    await expect(website).toBeVisible();
    await website.getByLabel('Websites value').fill(fields.website);
    await this.chooseResourceLabel(website, 'website', 'Personal');

    await this.tapFormAdd('Add date');
    await this.contactForm.locator('.contact-dates__row').first()
      .getByLabel('Contact date', { exact: true })
      .fill(fields.birthday);
    await this.tapFormAdd('Add note');
    await this.contactForm.getByRole('textbox', { name: 'Contact note' }).fill(fields.note);
    await this.tapFormAdd('Add work');
    const work = this.contactForm.locator('.contact-affiliations__card');
    await work.getByRole('textbox', { name: 'Organization' }).fill(fields.organization);
    await work.getByRole('textbox', { name: 'Department' }).fill(fields.department);
    await work.getByRole('textbox', { name: 'Job title' }).fill(fields.title);
    await work.getByRole('textbox', { name: 'Role' }).fill(fields.role);
    await this.uploadPhoto('png');
    await this.saveContact(fields.name);
  }

  /** Edit the same card; the Home email, birthday, and other fields remain untouched. */
  async editDetailedContact(fields: ContactEditFields): Promise<void> {
    await this.tap(this.page.locator('.contact-detail').getByRole('button', { name: 'Edit' }));
    await expect(this.contactForm).toBeVisible();
    await this.contactForm.getByRole('textbox', { name: 'Full or display name' })
      .fill(fields.name);
    await this.tapFormAdd('Add email');
    const workEmail = this.resourceRows('email').nth(1);
    await expect(workEmail).toBeVisible();
    await workEmail.getByLabel('Email addresses value')
      .fill(fields.workEmail);
    await this.chooseResourceLabel(workEmail, 'email', 'Work');
    await this.resourceRows('phone').first()
      .getByLabel('Phone numbers value').fill(fields.phone);
    await this.resourceRows('website').first()
      .getByLabel('Websites value').fill(fields.website);
    await this.tapFormAdd('Add date');
    const wedding = this.contactForm.locator('.contact-dates__row').nth(1);
    const dateKind = wedding.getByLabel(/^Choose date kind/);
    await this.chooseFormMenuItem(dateKind, 'Wedding');
    await expect(dateKind).toHaveAttribute('aria-label', /current kind Wedding$/);
    await wedding.getByLabel('Contact date', { exact: true }).fill(fields.weddingDate);
    await this.contactForm.getByRole('textbox', { name: 'Contact note' }).fill(fields.note);
    await this.contactForm.getByRole('textbox', { name: 'Job title' }).fill(fields.title);
    await this.uploadPhoto('gif');
    await this.saveContact(fields.name);
  }

  /** Match values to their visible labels, including the email's Primary badge. */
  async expectDetailedContact(fields: ExpectedContactDetails): Promise<void> {
    await expect(this.page.locator('.contact-detail__display-name')).toHaveText(fields.name);
    await expect(this.detailValue('Email addresses', 'Home')).toContainText(fields.homeEmail);
    await expect(this.detailValue('Email addresses', 'Home')).toContainText('Primary');
    if (fields.workEmail) {
      await expect(this.detailValue('Email addresses', 'Work')).toContainText(fields.workEmail);
      await expect(this.detailValue('Email addresses', 'Work')).not.toContainText('Primary');
    }
    await expect(this.detailValue('Phone numbers', 'Work')).toContainText(fields.phone);
    await expect(this.detailValue('Websites', 'Personal')).toContainText(fields.website);
    await expect(this.detailValue('Dates', 'Birthday'))
      .toHaveText(await this.formattedDate(fields.birthday));
    if (fields.weddingDate) {
      await expect(this.detailValue('Dates', 'Wedding'))
        .toHaveText(await this.formattedDate(fields.weddingDate));
    }
    for (const value of [fields.note, fields.organization, fields.department,
      `Title: ${fields.title}`, `Role: ${fields.role}`]) {
      await expect(this.contactDetails).toContainText(value);
    }
    for (const value of fields.absent ?? []) {
      await expect(this.contactDetails).not.toContainText(value);
    }
    const base64 = fields.photo === 'png' ? PNG_BASE64 : GIF_BASE64;
    await expect(this.page.locator('.contact-detail__avatar img'))
      .toHaveAttribute('src', `data:image/${fields.photo};base64,${base64}`);
  }

  async expectContactRow(name: string): Promise<void> {
    await expect(this.contactRow(name)).toBeVisible();
  }

  async expectContactAbsent(name: string): Promise<void> {
    await expect(this.contactRow(name)).toHaveCount(0);
  }

  async openContact(name: string): Promise<void> {
    console.log(`opening contact: ${name}`);
    await this.tap(this.contactRow(name));
    await expect(this.page.locator('.contact-detail__display-name')).toHaveText(name);
  }

  async deleteOpenContact(): Promise<void> {
    console.log('deleting currently open contact');
    await this.tap(this.page.locator('.contact-detail').getByRole('button', { name: 'Delete' }));
    // The row disappears optimistically; the notice follows the completed delete mutation; can take awhile
    console.log('awaiting contact deleted confirmation text');
    await expect(this.listNotice).toHaveText('1 contact deleted.', { timeout: 120_000 });
  }

  async expectTrashedContact(name: string): Promise<void> {
    await expect(this.page.locator('.trash-detail')).toContainText(name);
  }

  async openTrashedContact(name: string): Promise<void> {
    await this.tap(this.contactRow(name));
    await this.expectTrashedContact(name);
  }

  async expectBookNotDefault(name: string): Promise<void> {
    await this.openRail();
    await expect(this.bookButton(name)).toBeVisible();
    await expect(this.bookButton(name).locator('.contacts-rail__badge')).toHaveCount(0);
  }

  async expectBookAbsent(name: string): Promise<void> {
    await expect(this.bookButton(name)).toHaveCount(0);
  }

  async createBook(name: string, description: string): Promise<void> {
    console.log(`creating address book: ${name}`);
    await this.openList();
    await this.openRail();
    await this.tap(this.page.getByRole('button', { name: 'Create address book' }));
    // The Android rail stays over the new-book form until its drawer is closed.
    await this.closeRailOnPhone();
    await this.bookForm.getByLabel('Name', { exact: true }).fill(name);
    await this.bookForm.getByLabel(/Description/).fill(description);
    await expect(this.bookForm.getByLabel('Set as default')).not.toBeChecked();
    await this.tap(this.bookForm.getByRole('button', { name: 'Save address book' }));
    await expect(this.page.locator('.address-book-detail__display-name')).toHaveText(name);
    await expect(this.bookDetails).toContainText(description);
  }

  async editBook(name: string, renamed: string, description: string): Promise<void> {
    console.log(`editing address book: ${name}`);
    await this.selectBook(name);
    await this.tap(this.page.locator('.directory-list__addressbook-actions')
      .getByRole('button', { name: 'Edit address book' }));
    await this.bookForm.getByLabel('Name', { exact: true }).fill(renamed);
    await this.bookForm.getByLabel(/Description/).fill(description);
    await expect(this.bookForm.getByLabel('Set as default')).not.toBeChecked();
    await this.tap(this.bookForm.getByRole('button', { name: 'Save address book' }));
    await expect(this.page.locator('.address-book-detail__display-name')).toHaveText(renamed);
    await expect(this.bookDetails).toContainText(description);
    await this.openRail();
    await expect(this.bookButton(renamed)).toBeVisible();
    await this.expectBookAbsent(name);
  }

  async expectContactInBook(name: string, book: string): Promise<void> {
    // Changing books clears the row selected behind the address-book detail pane.
    // Returning also proves the contact remains listed in the renamed book.
    await this.displayAllContacts();
    await this.selectBook(book);
    await this.expectContactRow(name);
    await this.openContact(name);
    await expect(this.contactDetails).toContainText(book);
  }

  async requestBookDelete(name: string): Promise<void> {
    console.log(`deleting address book: ${name}`);
    await this.selectBook(name);
    await this.tap(this.page.locator('.directory-list__addressbook-actions')
      .getByRole('button', { name: 'Delete address book' }));
    await expect(this.confirmationDialog).toBeVisible();
  }

  /** Check the dialog's contact inventory before committing a book deletion. */
  async expectBookDeleteImpact(onlyHere: number, shared: number): Promise<void> {
    const exclusivePhrase = onlyHere === 1 ? 'contact belongs' : 'contacts belong';
    const sharedPhrase = shared === 1 ? 'contact has' : 'contacts have';
    await expect(this.confirmationDialog)
      .toContainText(`${onlyHere} ${exclusivePhrase} only to this address book`);
    await expect(this.confirmationDialog)
      .toContainText(`${shared} ${sharedPhrase} other address-book memberships`);
  }

  async confirmBookDelete(): Promise<void> {
    await this.tap(this.confirmationDialog.getByRole('button', { name: 'Delete address book' }));
  }

  /** Purge prior test Trash entries, or only the named cards from one case. */
  async purgeTestTrash(names?: readonly string[]): Promise<void> {
    await this.selectTrash();
    if (names) {
      for (const name of [...new Set(names)].sort((a, b) => b.length - a.length)) {
        expect(name.startsWith(CONTACT_PREFIX), 'Trash cleanup requires a test contact name')
          .toBe(true);
        await this.filter(name);
        while (await this.contactRow(name).count() > 0) {
          await this.deleteTrashedContactForever(name);
        }
      }
      await this.filter('');
      return;
    }

    await this.filter(CONTACT_PREFIX);
    const rows = this.page.locator('.contacts__row').filter({
      has: this.page.locator('.directory-list__row-content .name')
        .filter({ hasText: /^E2E-Contact/ }),
    });
    while (await rows.count() > 0) {
      const name = (await rows.first().locator('.name').textContent())?.trim();
      expect(name, 'Trash cleanup requires a named test contact').toBeTruthy();
      await this.deleteTrashedContactForever(name!);
    }
    await this.filter('');
  }

  private async deleteTrashedContactForever(name: string): Promise<void> {
    await this.openTrashedContact(name);
    await this.tap(this.page.locator('.trash-detail')
      .getByRole('button', { name: 'Delete Forever' }));
    await this.tap(this.confirmationDialog
      .getByRole('button', { name: 'Delete forever' }));
    await expect(this.listNotice).toHaveText('1 contact deleted forever.', { timeout: 60_000 });
    await expect(this.contactRow(name)).toHaveCount(0);
    await this.openList();
  }

  /** UI cleanup deletes cards first, then confirms that each book is empty. */
  async cleanUpThroughUi(contactNames: readonly string[], bookNames: readonly string[]): Promise<void> {
    console.log('cleaning up contacts and/or address books that were created by the test');
    expect(ACCTS_OIDC_EMAIL, 'ACCTS_OIDC_EMAIL must identify the BrowserStack UI account')
      .toBeTruthy();
    for (const name of contactNames) {
      expect(name.startsWith(CONTACT_PREFIX), 'UI cleanup requires a test contact name').toBe(true);
    }
    for (const name of bookNames) {
      expect(name.startsWith(BOOK_PREFIX), 'UI cleanup requires a test address book name')
        .toBe(true);
    }

    if (await this.confirmationDialog.isVisible()) {
      await this.tap(this.confirmationDialog.getByRole('button', { name: 'Cancel' }));
    }
    if (await this.contactForm.isVisible()) {
      await this.tap(this.contactForm.getByRole('button', { name: 'Cancel' }));
    } else if (await this.bookForm.isVisible()) {
      await this.tap(this.bookForm.getByRole('button', { name: 'Cancel' }));
    }

    await this.open();
    // The case may leave Trash or a named book selected; delete active cards from All contacts.
    await this.displayAllContacts();
    // A renamed card can also match its original name's filter; remove it first.
    for (const name of [...new Set(contactNames)].sort((a, b) => b.length - a.length)) {
      await this.filter(name);
      if (await this.contactRow(name).count() === 0) continue;
      await expect(this.contactRow(name)).toHaveCount(1);
      await this.openContact(name);
      await this.deleteOpenContact();
      await this.expectContactAbsent(name);
      await this.openList();
    }
    await this.purgeTestTrash(contactNames);
    await this.openRail();

    for (const name of new Set(bookNames)) {
      if (await this.bookButton(name).count() === 0) continue;
      await this.selectBook(name);
      await expect(
        this.bookButton(name).locator('.contacts-rail__count'),
        `Refusing UI cleanup of nonempty address book "${name}"`,
      ).toHaveText('0');
      await expect(this.page.locator('.contacts__row')).toHaveCount(0);
      await this.requestBookDelete(name);
      // This dialog inventories the server again, after the rail's cached count.
      await this.expectBookDeleteImpact(0, 0);
      await this.confirmBookDelete();
      await this.expectBookAbsent(name);
    }
  }
}
