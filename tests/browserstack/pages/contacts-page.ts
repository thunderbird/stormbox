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

  /** Android BrowserStack uses forced taps for visible remote touch controls. */
  private async tap(target: Locator): Promise<void> {
    await expect(target).toBeVisible();
    await target.click({ force: this.onAndroid });
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
    // ContactDetailPane renders these resource fieldsets in this fixed order.
    const section = { email: 0, phone: 1, website: 2 }[kind];
    return this.contactForm.locator('.contact-resource').nth(section)
      .locator('.contact-resource__row');
  }

  private async chooseResourceLabel(row: Locator, kind: string, label: string): Promise<void> {
    const summary = row.getByLabel(new RegExp(`^Choose ${kind} label`));
    await this.tap(summary);
    await this.tap(row.getByRole('menuitemradio', { name: label, exact: true }));
    await expect(summary).toHaveAttribute('aria-label', new RegExp(`current label ${label}$`));
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
    // Android has no prepared storage state, so check sign-in after reloading.
    await this.stormbox.signInIfNeeded(this.projectName);
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
    await this.tap(this.bookButton(name));
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
    await this.beginContact(fields.name, fields.homeEmail);
    const home = this.resourceRows('email').first();
    await this.chooseResourceLabel(home, 'email', 'Home');
    await expect(home.getByRole('button', { name: 'Primary' }))
      .toHaveAttribute('aria-pressed', 'true');

    await this.tap(this.contactForm.getByRole('button', { name: 'Add phone' }));
    const phone = this.resourceRows('phone').first();
    await phone.getByRole('textbox', { name: 'Phone numbers value' }).fill(fields.phone);
    await this.chooseResourceLabel(phone, 'phone', 'Work');

    await this.tap(this.contactForm.getByRole('button', { name: 'Add website' }));
    const website = this.resourceRows('website').first();
    await website.getByRole('textbox', { name: 'Websites value' }).fill(fields.website);
    await this.chooseResourceLabel(website, 'website', 'Personal');

    await this.tap(this.contactForm.getByRole('button', { name: 'Add date' }));
    await this.contactForm.getByRole('textbox', { name: 'Contact date' })
      .fill(fields.birthday);
    await this.tap(this.contactForm.getByRole('button', { name: 'Add note' }));
    await this.contactForm.getByRole('textbox', { name: 'Contact note' }).fill(fields.note);
    await this.tap(this.contactForm.getByRole('button', { name: 'Add work' }));
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
    await this.tap(this.contactForm.getByRole('button', { name: 'Add email' }));
    const workEmail = this.resourceRows('email').nth(1);
    await workEmail.getByRole('textbox', { name: 'Email addresses value' })
      .fill(fields.workEmail);
    await this.chooseResourceLabel(workEmail, 'email', 'Work');
    await this.resourceRows('phone').first()
      .getByRole('textbox', { name: 'Phone numbers value' }).fill(fields.phone);
    await this.resourceRows('website').first()
      .getByRole('textbox', { name: 'Websites value' }).fill(fields.website);
    await this.tap(this.contactForm.getByRole('button', { name: 'Add date' }));
    const wedding = this.contactForm.locator('.contact-dates__row').nth(1);
    await this.tap(wedding.getByLabel(/^Choose date kind/));
    await this.tap(wedding.getByRole('menuitemradio', { name: 'Wedding' }));
    await wedding.getByRole('textbox', { name: 'Contact date' }).fill(fields.weddingDate);
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
    await this.tap(this.contactRow(name));
    await expect(this.page.locator('.contact-detail__display-name')).toHaveText(name);
  }

  async deleteOpenContact(): Promise<void> {
    await this.tap(this.page.locator('.contact-detail').getByRole('button', { name: 'Delete' }));
    // The row disappears optimistically; the notice follows the completed delete mutation.
    await expect(this.listNotice).toHaveText('1 contact deleted.', { timeout: 60_000 });
  }

  async expectTrashedContact(name: string): Promise<void> {
    await expect(this.page.locator('.trash-detail')).toContainText(name);
  }

  async openTrashedContact(name: string): Promise<void> {
    await this.tap(this.contactRow(name));
    await this.expectTrashedContact(name);
  }

  async defaultBookName(): Promise<string> {
    await this.openRail();
    const name = (await this.page.locator('.contacts-rail__book')
      .filter({ has: this.page.locator('.contacts-rail__badge') })
      .locator('.contacts-rail__name').textContent())?.trim();
    expect(name, 'The account must have a default address book').toBeTruthy();
    return name!;
  }

  async expectDefaultBook(name: string): Promise<void> {
    await this.openRail();
    await expect(this.bookButton(name)).toContainText('Personal');
  }

  async expectBookNotDefault(name: string): Promise<void> {
    await this.openRail();
    await expect(this.bookButton(name)).not.toContainText('Personal');
  }

  async expectBookAbsent(name: string): Promise<void> {
    await expect(this.bookButton(name)).toHaveCount(0);
  }

  async createBook(name: string, description: string): Promise<void> {
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
    await this.selectBook(book);
    await this.expectContactRow(name);
    await this.openContact(name);
    await expect(this.contactDetails).toContainText(book);
  }

  async requestBookDelete(name: string): Promise<void> {
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

  /** Use Webmail UI to permanently remove matching Trash entries left by previously interrupted runs. */
  async purgeTestTrash(): Promise<void> {
    await this.selectTrash();
    await this.filter(CONTACT_PREFIX);
    const rows = this.page.locator('.contacts__row').filter({
      has: this.page.locator('.directory-list__row-content .name')
        .filter({ hasText: /^E2E-Contact/ }),
    });
    while (await rows.count() > 0) {
      const name = (await rows.first().locator('.name').textContent())?.trim();
      expect(name, 'Trash cleanup requires a named test contact').toBeTruthy();
      await this.openTrashedContact(name!);
      await this.tap(this.page.locator('.trash-detail')
        .getByRole('button', { name: 'Delete Forever' }));
      await this.tap(this.confirmationDialog
        .getByRole('button', { name: 'Delete forever' }));
      await expect(this.listNotice).toHaveText('1 contact deleted forever.', { timeout: 60_000 });
      await expect(this.contactRow(name!)).toHaveCount(0);
      await this.openList();
    }
    await this.filter('');
  }

  /** UI cleanup deletes cards first, then confirms that each book is empty. */
  async cleanUpThroughUi(): Promise<void> {
    expect(ACCTS_OIDC_EMAIL, 'ACCTS_OIDC_EMAIL must identify the BrowserStack UI account')
      .toBeTruthy();

    if (await this.confirmationDialog.isVisible()) {
      await this.tap(this.confirmationDialog.getByRole('button', { name: 'Cancel' }));
    }
    if (await this.contactForm.isVisible()) {
      await this.tap(this.contactForm.getByRole('button', { name: 'Cancel' }));
    } else if (await this.bookForm.isVisible()) {
      await this.tap(this.bookForm.getByRole('button', { name: 'Cancel' }));
    }

    await this.open();
    await this.assertExpectedPrimaryMailIdentityVisible();
    await this.filter(CONTACT_PREFIX);

    const rows = this.page.locator('.contacts__row').filter({
      has: this.page.locator('.directory-list__row-content .name')
        .filter({ hasText: /^E2E-Contact/ }),
    });

    while (await rows.count() > 0) {
      const name = (await rows.first().locator('.name').textContent())?.trim();
      expect(name, 'Contact cleanup requires a named test contact').toBeTruthy();
      await this.openContact(name!);
      await this.deleteOpenContact();
      await this.expectContactAbsent(name!);
      await this.openList();
    }
    await this.purgeTestTrash();
    await this.openRail();

    const books = await this.page.locator('.contacts-rail__name').allTextContents();

    for (const name of books.filter((value) => value.startsWith(BOOK_PREFIX))) {
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
