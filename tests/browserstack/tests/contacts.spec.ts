import { randomUUID } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  ACCTS_OIDC_EMAIL,
  PLAYWRIGHT_TAG_DESKTOP,
  PLAYWRIGHT_TAG_MOBILE,
  PRIMARY_THUNDERMAIL_EMAIL,
} from '../const/constants';
import {
  deleteAddressBooksByPrefix,
  deleteContactsByPrefix,
} from '../helpers/jmap-client';
import { StormboxPage } from '../pages/stormbox-page';

const CONTACT_PREFIX = 'E2E-Contact';
const BOOK_PREFIX = 'E2E-AddressBook';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

function uniqueSuffix(): string {
  return `${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function contactRow(page: Page, name: string): Locator {
  return page.locator('.contacts__row').filter({
    has: page.locator('.directory-list__row-content .name').getByText(name, { exact: true }),
  });
}

function bookButton(page: Page, name: string): Locator {
  return page.locator('.contacts-rail__book').filter({
    has: page.locator('.contacts-rail__name').getByText(name, { exact: true }),
  });
}

function detailSection(page: Page, heading: string): Locator {
  return page.locator('.contact-detail__body section').filter({
    has: page.getByRole('heading', { name: heading, exact: true }),
  });
}

function detailValueForLabel(page: Page, heading: string, label: string): Locator {
  return detailSection(page, heading)
    .locator('dt').filter({ hasText: new RegExp(`^${label}$`) })
    .locator('xpath=following-sibling::dd[1]');
}

async function setContactFilter(stormbox: StormboxPage, value: string): Promise<void> {
  await stormbox.quickFilter.fill(value);
  if (value) {
    await expect(stormbox.quickFilter).not.toHaveClass(/quick-filter__input--empty/);
  } else {
    await expect(stormbox.quickFilter).toHaveClass(/quick-filter__input--empty/);
  }
}

async function formattedDate(page: Page, isoDate: string): Promise<string> {
  return page.evaluate((iso) => {
    const [year, month, day] = iso.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    return new Intl.DateTimeFormat(undefined, {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    }).format(date);
  }, isoDate);
}

async function openContacts(page: Page, stormbox: StormboxPage): Promise<void> {
  expect(ACCTS_OIDC_EMAIL, 'ACCTS_OIDC_EMAIL must identify the BrowserStack UI account')
    .toBeTruthy();
  await expect(stormbox.accountMenuIdentity).toHaveText(ACCTS_OIDC_EMAIL);
  await stormbox.contactsSpaceButton.click();
  await expect(page.locator('.contacts')).toBeVisible({ timeout: 30_000 });
  await expect(stormbox.quickFilter).toBeVisible();
  await setContactFilter(stormbox, '');
}

async function openList(page: Page): Promise<void> {
  const back = page.locator(
    '.contact-detail__header button[aria-label="Back"], '
    + '.address-book-detail__header button[aria-label="Back"], '
    + '.trash-detail__header button[aria-label="Back"]',
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await page.locator('.directory-shell__list').isVisible()) return;
    await back.click();
  }
  await expect(page.locator('.directory-shell__list')).toBeVisible();
}

async function openRail(page: Page, stormbox: StormboxPage): Promise<void> {
  const sidebar = page.locator('.sidebar-slot');
  const rail = page.getByRole('navigation', { name: 'Address books' });
  if (await sidebar.getAttribute('aria-hidden') === 'false') return;
  await stormbox.showAddressBookListButton.click();
  await expect(sidebar).toHaveAttribute('aria-hidden', 'false');
  await expect(rail).toBeVisible();
}

async function closeRailOnPhone(page: Page): Promise<void> {
  if (await page.locator('.directory-shell').getAttribute('data-layout') !== 'phone') return;
  const hide = page.getByRole('button', { name: 'Hide address book list' });
  if (await hide.isVisible()) {
    await hide.click();
    await expect(page.locator('.sidebar-slot')).toHaveAttribute('aria-hidden', 'true');
  }
}

async function selectAllContacts(page: Page, stormbox: StormboxPage): Promise<void> {
  await openList(page);
  await openRail(page, stormbox);
  await bookButton(page, 'All contacts').click();
  await closeRailOnPhone(page);
  await expect(page.locator('.directory-list__header h2')).toHaveText('All contacts');
  await expect(page.getByRole('listbox', { name: 'All contacts' }))
    .toHaveAttribute('aria-busy', 'false');
}

async function selectTrash(page: Page, stormbox: StormboxPage): Promise<void> {
  await openList(page);
  await openRail(page, stormbox);
  await bookButton(page, 'Trash').click();
  await closeRailOnPhone(page);
  await expect(page.locator('.directory-list__header h2')).toHaveText('Trash');
  await expect(page.getByRole('listbox', { name: 'Trash', exact: true }))
    .toHaveAttribute('aria-busy', 'false');
}

async function selectBook(page: Page, stormbox: StormboxPage, name: string): Promise<void> {
  await openList(page);
  await openRail(page, stormbox);
  await bookButton(page, name).click();
  await closeRailOnPhone(page);
  await expect(page.locator('.directory-list__header h2')).toHaveText(name);
  await expect(page.getByRole('listbox', { name, exact: true }))
    .toHaveAttribute('aria-busy', 'false');
}

async function assertContactAccount(page: Page, stormbox: StormboxPage): Promise<void> {
  const expectedEmail = PRIMARY_THUNDERMAIL_EMAIL.trim();
  expect(expectedEmail, 'PRIMARY_THUNDERMAIL_EMAIL must identify the BrowserStack JMAP account')
    .toBeTruthy();
  await openList(page);
  await openRail(page, stormbox);
  await bookButton(page, 'Identities').click();
  await closeRailOnPhone(page);
  await expect(page.locator('.directory-list__header h2')).toHaveText('Identities');
  await expect(page.getByRole('listbox', { name: 'Identities' }))
    .toHaveAttribute('aria-busy', 'false');
  await setContactFilter(stormbox, expectedEmail);
  await expect(page.locator('.contacts__row .email').getByText(expectedEmail, { exact: true }))
    .toBeVisible();
  await setContactFilter(stormbox, '');
  await selectAllContacts(page, stormbox);
}

async function createContact(
  page: Page,
  stormbox: StormboxPage,
  name: string,
  email: string,
): Promise<Locator> {
  await openList(page);
  await openRail(page, stormbox);
  await stormbox.addContactButton.click();
  const form = page.locator('.contact-detail__editor');
  await expect(form).toBeVisible();
  await form.getByRole('textbox', { name: 'Full or display name' }).fill(name);
  await form.getByRole('textbox', { name: 'Email addresses value' }).fill(email);
  return form;
}

async function chooseResourceLabel(row: Locator, kind: string, label: string): Promise<void> {
  await row.getByLabel(new RegExp(`^Choose ${kind} label`)).click();
  await row.getByRole('menuitemradio', { name: label, exact: true }).click();
  await expect(row.getByLabel(new RegExp(`^Choose ${kind} label`)))
    .toHaveAttribute('aria-label', new RegExp(`current label ${label}$`));
}

async function saveContact(page: Page, form: Locator, name: string): Promise<void> {
  await form.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.locator('.contact-detail__editor')).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('.contact-detail__display-name')).toHaveText(name);
}

async function createBook(
  page: Page,
  stormbox: StormboxPage,
  name: string,
  description: string,
): Promise<void> {
  await openList(page);
  await openRail(page, stormbox);
  await page.getByRole('button', { name: 'Create address book' }).click();
  const form = page.locator('.address-book-detail__editor');
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByLabel(/Description/).fill(description);
  await expect(form.getByLabel('Set as default')).not.toBeChecked();
  await form.getByRole('button', { name: 'Save address book' }).click();
  await expect(page.locator('.address-book-detail__display-name')).toHaveText(name);
  await expect(page.locator('.address-book-detail__body')).toContainText(description);
}

async function deleteBook(page: Page, stormbox: StormboxPage, name: string): Promise<Locator> {
  await selectBook(page, stormbox, name);
  await page.locator('.directory-list__addressbook-actions')
    .getByRole('button', { name: 'Delete address book' }).click();
  return page.getByRole('alertdialog');
}

async function purgeTestTrash(page: Page, stormbox: StormboxPage): Promise<void> {
  await selectTrash(page, stormbox);
  await setContactFilter(stormbox, CONTACT_PREFIX);
  const rows = page.locator('.contacts__row').filter({
    has: page.locator('.directory-list__row-content .name')
      .filter({ hasText: /^E2E-Contact/ }),
  });
  while (await rows.count() > 0) {
    const name = await rows.first().locator('.name').textContent();
    await rows.first().click();
    await page.locator('.trash-detail').getByRole('button', { name: 'Delete Forever' }).click();
    await page.getByRole('alertdialog')
      .getByRole('button', { name: 'Delete forever' }).click();
    await expect(page.locator('.contacts__row').filter({
      has: page.locator('.directory-list__row-content .name')
        .getByText(name ?? '', { exact: true }),
    })).toHaveCount(0);
    await openList(page);
  }
  await setContactFilter(stormbox, '');
}

async function cleanUpThroughUi(page: Page, stormbox: StormboxPage): Promise<void> {
  expect(ACCTS_OIDC_EMAIL, 'ACCTS_OIDC_EMAIL must identify the BrowserStack UI account')
    .toBeTruthy();
  await expect(stormbox.accountMenuIdentity).toHaveText(ACCTS_OIDC_EMAIL);
  const dialog = page.getByRole('alertdialog');
  if (await dialog.isVisible()) {
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  }
  const contactEditor = page.locator('.contact-detail__editor');
  const bookEditor = page.locator('.address-book-detail__editor');
  if (await contactEditor.isVisible()) {
    await contactEditor.getByRole('button', { name: 'Cancel' }).click();
  } else if (await bookEditor.isVisible()) {
    await bookEditor.getByRole('button', { name: 'Cancel' }).click();
  }
  await openContacts(page, stormbox);
  await assertContactAccount(page, stormbox);
  await setContactFilter(stormbox, CONTACT_PREFIX);
  const rows = page.locator('.contacts__row').filter({
    has: page.locator('.directory-list__row-content .name')
      .filter({ hasText: /^E2E-Contact/ }),
  });
  while (await rows.count() > 0) {
    const name = await rows.first().locator('.name').textContent();
    await rows.first().click();
    await page.locator('.contact-detail').getByRole('button', { name: 'Delete' }).click();
    await expect(contactRow(page, name ?? '')).toHaveCount(0);
    await openList(page);
  }
  await purgeTestTrash(page, stormbox);

  await openRail(page, stormbox);
  const books = await page.locator('.contacts-rail__name').allTextContents();
  for (const name of books.filter((value) => value.startsWith(BOOK_PREFIX))) {
    await selectBook(page, stormbox, name);
    await expect(
      bookButton(page, name).locator('.contacts-rail__count'),
      `Refusing UI cleanup of nonempty address book "${name}"`,
    ).toHaveText('0');
    await expect(page.locator('.contacts__row')).toHaveCount(0);
    const confirmation = await deleteBook(page, stormbox, name);
    await expect(confirmation).toContainText('0 contacts belong only to this address book');
    await expect(confirmation).toContainText('0 contacts have other address-book memberships');
    await confirmation.getByRole('button', { name: 'Delete address book' }).click();
    await expect(bookButton(page, name)).toHaveCount(0);
  }
}

test.describe('stormbox contacts and address books', {
  tag: [PLAYWRIGHT_TAG_DESKTOP, PLAYWRIGHT_TAG_MOBILE],
}, () => {
  let stormbox: StormboxPage;
  let signedIn = false;

  test.beforeEach(async ({ page }, testInfo) => {
    signedIn = false;
    stormbox = new StormboxPage(page);
    await deleteContactsByPrefix(CONTACT_PREFIX);
    await deleteAddressBooksByPrefix(BOOK_PREFIX);

    const missing = await stormbox.missingRequiredBrowserFeatures();
    test.skip(missing.length > 0,
      `Stormbox cannot run in this browser. Missing: ${missing.join(', ')}.`);
    await stormbox.navigate();
    await stormbox.signInIfNeeded(testInfo.project.name);
    signedIn = true;
    await openContacts(page, stormbox);
    await assertContactAccount(page, stormbox);
    await purgeTestTrash(page, stormbox);
    await selectAllContacts(page, stormbox);
  });

  test.afterEach(async ({ page }) => {
    if (signedIn) await cleanUpThroughUi(page, stormbox);
  });

  test('creates and edits a contact with its details and photo', async ({ page }, testInfo) => {
    testInfo.setTimeout(8 * 60 * 1000);
    const suffix = uniqueSuffix();
    const originalName = `${CONTACT_PREFIX}-${suffix}-CreateEdit`;
    const renamed = `${originalName}-Renamed`;
    const homeEmail = `home-${suffix}@example.com`;
    const workEmail = `work-${suffix}@example.com`;
    const website = `https://example.com/${suffix}/personal`;
    const newWebsite = `https://example.com/${suffix}/updated`;
    const originalNote = `Original contact note ${suffix}`;
    const updatedNote = `Updated contact note ${suffix}`;
    const birthday = await formattedDate(page, '1985-07-13');
    const weddingDate = await formattedDate(page, '2010-06-15');

    const form = await createContact(page, stormbox, originalName, homeEmail);
    await chooseResourceLabel(form.locator('.contact-resource__row').nth(0), 'email', 'Home');
    await expect(form.locator('.contact-resource__row').nth(0)
      .getByRole('button', { name: 'Primary' })).toHaveAttribute('aria-pressed', 'true');
    await form.getByRole('button', { name: 'Add phone' }).click();
    const phone = form.locator('.contact-resource__row').nth(1);
    await phone.getByRole('textbox', { name: 'Phone numbers value' }).fill('+15550101');
    await chooseResourceLabel(phone, 'phone', 'Work');
    await form.getByRole('button', { name: 'Add website' }).click();
    const link = form.locator('.contact-resource__row').nth(2);
    await link.getByRole('textbox', { name: 'Websites value' }).fill(website);
    await chooseResourceLabel(link, 'website', 'Personal');
    await form.getByRole('button', { name: 'Add date' }).click();
    await form.getByRole('textbox', { name: 'Contact date' }).fill('1985-07-13');
    await form.getByRole('button', { name: 'Add note' }).click();
    await form.getByRole('textbox', { name: 'Contact note' }).fill(originalNote);
    await form.getByRole('button', { name: 'Add work' }).click();
    const work = form.locator('.contact-affiliations__card');
    await work.getByRole('textbox', { name: 'Organization' }).fill('Example Labs');
    await work.getByRole('textbox', { name: 'Department' }).fill('Research');
    await work.getByRole('textbox', { name: 'Job title' }).fill('Engineer');
    await work.getByRole('textbox', { name: 'Role' }).fill('Contributor');
    await form.locator('.contact-detail__photo-input').setInputFiles({
      name: 'contact.png', mimeType: 'image/png', buffer: Buffer.from(PNG_BASE64, 'base64'),
    });
    await expect(form.locator('.contact-detail__photo-editor img'))
      .toHaveAttribute('src', `data:image/png;base64,${PNG_BASE64}`);
    await saveContact(page, form, originalName);

    const details = page.locator('.contact-detail__body');
    await expect(detailValueForLabel(page, 'Email addresses', 'Home')).toContainText(homeEmail);
    await expect(detailValueForLabel(page, 'Email addresses', 'Home')).toContainText('Primary');
    await expect(detailValueForLabel(page, 'Phone numbers', 'Work')).toContainText('+15550101');
    await expect(detailValueForLabel(page, 'Websites', 'Personal')).toContainText(website);
    await expect(detailValueForLabel(page, 'Dates', 'Birthday')).toHaveText(birthday);
    await expect(details).toContainText(originalNote);
    await expect(details).toContainText('Example Labs');
    await expect(details).toContainText('Research');
    await expect(details).toContainText('Title: Engineer');
    await expect(details).toContainText('Role: Contributor');
    await expect(page.locator('.contact-detail__avatar img'))
      .toHaveAttribute('src', `data:image/png;base64,${PNG_BASE64}`);

    await page.locator('.contact-detail').getByRole('button', { name: 'Edit' }).click();
    const edit = page.locator('.contact-detail__editor');
    await edit.getByRole('textbox', { name: 'Full or display name' }).fill(renamed);
    await edit.getByRole('button', { name: 'Add email' }).click();
    const workEmailRow = edit.locator('.contact-resource__row').nth(1);
    await workEmailRow.getByRole('textbox', { name: 'Email addresses value' }).fill(workEmail);
    await chooseResourceLabel(workEmailRow, 'email', 'Work');
    await edit.locator('.contact-resource__row').nth(2)
      .getByRole('textbox', { name: 'Phone numbers value' }).fill('+15550202');
    await edit.locator('.contact-resource__row').nth(3)
      .getByRole('textbox', { name: 'Websites value' }).fill(newWebsite);
    await edit.getByRole('button', { name: 'Add date' }).click();
    const wedding = edit.locator('.contact-dates__row').nth(1);
    await wedding.getByLabel(/^Choose date kind/).click();
    await wedding.getByRole('menuitemradio', { name: 'Wedding' }).click();
    await wedding.getByRole('textbox', { name: 'Contact date' }).fill('2010-06-15');
    await edit.getByRole('textbox', { name: 'Contact note' }).fill(updatedNote);
    await edit.getByRole('textbox', { name: 'Job title' }).fill('Principal Engineer');
    await edit.locator('.contact-detail__photo-input').setInputFiles({
      name: 'contact.gif', mimeType: 'image/gif', buffer: Buffer.from(GIF_BASE64, 'base64'),
    });
    await expect(edit.locator('.contact-detail__photo-editor img'))
      .toHaveAttribute('src', `data:image/gif;base64,${GIF_BASE64}`);
    await saveContact(page, edit, renamed);

    await page.reload();
    await stormbox.signInIfNeeded(testInfo.project.name);
    await openContacts(page, stormbox);
    await selectAllContacts(page, stormbox);
    await setContactFilter(stormbox, renamed);
    await contactRow(page, renamed).click();
    await expect(page.locator('.contact-detail__display-name')).toHaveText(renamed);
    await expect(detailValueForLabel(page, 'Email addresses', 'Home')).toContainText(homeEmail);
    await expect(detailValueForLabel(page, 'Email addresses', 'Home')).toContainText('Primary');
    await expect(detailValueForLabel(page, 'Email addresses', 'Work')).toContainText(workEmail);
    await expect(detailValueForLabel(page, 'Email addresses', 'Work')).not.toContainText('Primary');
    await expect(detailValueForLabel(page, 'Phone numbers', 'Work')).toContainText('+15550202');
    await expect(detailValueForLabel(page, 'Websites', 'Personal')).toContainText(newWebsite);
    await expect(detailValueForLabel(page, 'Dates', 'Birthday')).toHaveText(birthday);
    await expect(detailValueForLabel(page, 'Dates', 'Wedding')).toHaveText(weddingDate);
    await expect(details).toContainText(updatedNote);
    await expect(details).toContainText('Title: Principal Engineer');
    await expect(details).toContainText('Example Labs');
    await expect(details).toContainText('Research');
    await expect(details).toContainText('Role: Contributor');
    await expect(details).not.toContainText('+15550101');
    await expect(details).not.toContainText(website);
    await expect(details).not.toContainText(originalNote);
    await expect(page.locator('.contact-detail__avatar img'))
      .toHaveAttribute('src', `data:image/gif;base64,${GIF_BASE64}`);
  });

  test('deletes a separate contact into Trash', async ({ page }) => {
    const suffix = uniqueSuffix();
    const name = `${CONTACT_PREFIX}-${suffix}-Delete`;
    const email = `delete-${suffix}@example.com`;
    const form = await createContact(page, stormbox, name, email);
    await saveContact(page, form, name);
    await selectAllContacts(page, stormbox);
    await setContactFilter(stormbox, name);
    await expect(contactRow(page, name)).toBeVisible();
    await contactRow(page, name).click();
    await page.locator('.contact-detail').getByRole('button', { name: 'Delete' }).click();
    await expect(contactRow(page, name)).toHaveCount(0);
    await selectTrash(page, stormbox);
    await expect(contactRow(page, name)).toBeVisible();
    await contactRow(page, name).click();
    await expect(page.locator('.trash-detail')).toContainText(name);
  });

  test('creates and edits an address book containing a contact', async ({ page }) => {
    const suffix = uniqueSuffix();
    const name = `${BOOK_PREFIX}-${suffix}-CreateEdit`;
    const renamed = `${name}-Renamed`;
    const contactName = `${CONTACT_PREFIX}-${suffix}-BookMember`;
    const email = `book-${suffix}@example.com`;
    await openRail(page, stormbox);
    const defaultName = await page.locator('.contacts-rail__book')
      .filter({ has: page.locator('.contacts-rail__badge') })
      .locator('.contacts-rail__name').textContent();
    expect(defaultName).toBeTruthy();

    await createBook(page, stormbox, name, 'Initial BrowserStack book');
    await expect(bookButton(page, name)).not.toContainText('Personal');
    const form = await createContact(page, stormbox, contactName, email);
    await saveContact(page, form, contactName);
    await selectBook(page, stormbox, name);
    await expect(contactRow(page, contactName)).toBeVisible();
    await page.locator('.directory-list__addressbook-actions')
      .getByRole('button', { name: 'Edit address book' }).click();
    const edit = page.locator('.address-book-detail__editor');
    await edit.getByLabel('Name', { exact: true }).fill(renamed);
    await edit.getByLabel(/Description/).fill('Updated BrowserStack book');
    await expect(edit.getByLabel('Set as default')).not.toBeChecked();
    await edit.getByRole('button', { name: 'Save address book' }).click();
    await expect(page.locator('.address-book-detail__display-name')).toHaveText(renamed);
    await expect(page.locator('.address-book-detail__body'))
      .toContainText('Updated BrowserStack book');
    await openRail(page, stormbox);
    await expect(bookButton(page, renamed)).toBeVisible();
    await expect(bookButton(page, name)).toHaveCount(0);
    await expect(bookButton(page, defaultName!)).toContainText('Personal');
    await expect(bookButton(page, renamed)).not.toContainText('Personal');
    await selectBook(page, stormbox, renamed);
    await expect(contactRow(page, contactName)).toBeVisible();
    await contactRow(page, contactName).click();
    await expect(page.locator('.contact-detail__body')).toContainText(renamed);
  });

  test('deletes a separate address book and its sole contact', async ({ page }) => {
    const suffix = uniqueSuffix();
    const name = `${BOOK_PREFIX}-${suffix}-Delete`;
    const contactName = `${CONTACT_PREFIX}-${suffix}-DeletedBookMember`;
    const email = `book-delete-${suffix}@example.com`;
    await createBook(page, stormbox, name, 'Book to delete');
    const form = await createContact(page, stormbox, contactName, email);
    await saveContact(page, form, contactName);
    await selectBook(page, stormbox, name);
    await expect(contactRow(page, contactName)).toBeVisible();
    const dialog = await deleteBook(page, stormbox, name);
    await expect(dialog).toContainText('1 contact belongs only to this address book');
    await dialog.getByRole('button', { name: 'Delete address book' }).click();
    await expect(bookButton(page, name)).toHaveCount(0);
    await selectAllContacts(page, stormbox);
    await setContactFilter(stormbox, contactName);
    await expect(contactRow(page, contactName)).toHaveCount(0);
    await selectTrash(page, stormbox);
    await expect(contactRow(page, contactName)).toHaveCount(0);
  });
});
