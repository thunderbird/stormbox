import { randomUUID } from 'node:crypto';

import { test } from '@playwright/test';

import {
  PLAYWRIGHT_TAG_DESKTOP,
  PLAYWRIGHT_TAG_MOBILE,
} from '../const/constants';
import {
  deleteAddressBooksByPrefix,
  deleteContactsByPrefix,
} from '../helpers/jmap-client';
import {
  BOOK_PREFIX,
  CONTACT_PREFIX,
  ContactsPage,
  type ContactCreateFields,
  type ContactEditFields,
} from '../pages/contacts-page';
import { StormboxPage } from '../pages/stormbox-page';

function uniqueSuffix(): string {
  return `${Date.now()}-${randomUUID().slice(0, 8)}`;
}

test.describe('stormbox contacts and address books', {
  tag: [PLAYWRIGHT_TAG_DESKTOP, PLAYWRIGHT_TAG_MOBILE],
}, () => {
  let contacts: ContactsPage;
  let signedIn = false;

  test.beforeEach(async ({ page }, testInfo) => {
    signedIn = false;
    const stormbox = new StormboxPage(page);
    contacts = new ContactsPage(page, stormbox, testInfo.project.name);

    // Clear leftovers from interrupted runs before each case. Sweep cards before books;
    // BrowserStack lanes sharing this account must not run at the same time.
    await deleteContactsByPrefix(CONTACT_PREFIX);
    await deleteAddressBooksByPrefix(BOOK_PREFIX);

    const missing = await stormbox.missingRequiredBrowserFeatures();
    test.skip(missing.length > 0,
      `Stormbox cannot run in this browser. Missing: ${missing.join(', ')}.`);

    await stormbox.navigate();

    // Android signs in through the UI; desktop projects use their prepared auth state.
    await stormbox.signInIfNeeded(testInfo.project.name);
    signedIn = true;
    await contacts.open();
    await contacts.assertExpectedPrimaryMailIdentityVisible();

    // The JMAP card sweep leaves recoverable Contacts Trash entries behind.
    await contacts.purgeTestTrash();
    await contacts.displayAllContacts();
  });

  test.afterEach(async () => {
    // UI cleanup covers artifacts from the current case, including Trash.
    if (signedIn) await contacts.cleanUpThroughUi();
  });

  test('creates and edits a contact with its details and photo', async ({}, testInfo) => {
    testInfo.setTimeout(8 * 60 * 1000);
    const suffix = uniqueSuffix();
    const initial: ContactCreateFields = {
      name: `${CONTACT_PREFIX}-${suffix}-CreateEdit`,
      homeEmail: `home-${suffix}@example.com`,
      phone: '+15550101',
      website: `https://example.com/${suffix}/personal`,
      birthday: '1985-07-13',
      note: `Original contact note ${suffix}`,
      organization: 'Example Labs',
      department: 'Research',
      title: 'Engineer',
      role: 'Contributor',
    };
    const edited: ContactEditFields = {
      name: `${initial.name}-Renamed`,
      workEmail: `work-${suffix}@example.com`,
      phone: '+15550202',
      website: `https://example.com/${suffix}/updated`,
      weddingDate: '2010-06-15',
      note: `Updated contact note ${suffix}`,
      title: 'Principal Engineer',
    };

    await test.step('create and verify all contact details', async () => {
      await contacts.createDetailedContact(initial);
      await contacts.expectDetailedContact({ ...initial, photo: 'png' });
    });

    await test.step('edit the same contact and replace its photo', async () => {
      await contacts.editDetailedContact(edited);
    });

    await test.step('reload and verify changed and retained details', async () => {
      await contacts.reloadAndOpen();
      await contacts.displayAllContacts();
      await contacts.filter(edited.name);
      await contacts.openContact(edited.name);
      await contacts.expectDetailedContact({
        ...initial,
        ...edited,
        photo: 'gif',
        absent: [initial.phone, initial.website, initial.note],
      });
    });
  });

  test('deletes a separate contact into Trash', async () => {
    const suffix = uniqueSuffix();
    const name = `${CONTACT_PREFIX}-${suffix}-Delete`;
    const email = `delete-${suffix}@example.com`;

    await contacts.createBasicContact(name, email);
    await contacts.displayAllContacts();
    await contacts.filter(name);
    await contacts.expectContactRow(name);
    await contacts.openContact(name);
    await contacts.deleteOpenContact();
    await contacts.expectContactAbsent(name);

    // A contact delete moves this independent card to Trash.
    await contacts.selectTrash();
    await contacts.expectContactRow(name);
    await contacts.openTrashedContact(name);
  });

  test('creates and edits an address book containing a contact', async () => {
    const suffix = uniqueSuffix();
    const name = `${BOOK_PREFIX}-${suffix}-CreateEdit`;
    const renamed = `${name}-Renamed`;
    const contactName = `${CONTACT_PREFIX}-${suffix}-BookMember`;
    await contacts.createBook(name, 'Initial BrowserStack book');
    await contacts.expectBookNotDefault(name);
    // Creating in the selected book gives the card a single book membership.
    await contacts.selectBook(name);
    await contacts.createBasicContact(contactName, `book-${suffix}@example.com`);
    await contacts.selectBook(name);
    await contacts.expectContactRow(contactName);

    await contacts.editBook(name, renamed, 'Updated BrowserStack book');
    await contacts.expectBookNotDefault(renamed);
    await contacts.expectContactInBook(contactName, renamed);
  });

  test('deletes a separate address book and its sole contact', async () => {
    const suffix = uniqueSuffix();
    const name = `${BOOK_PREFIX}-${suffix}-Delete`;
    const contactName = `${CONTACT_PREFIX}-${suffix}-DeletedBookMember`;

    await contacts.createBook(name, 'Book to delete');
    // The confirmation inventory must report this card as exclusive to the book.
    await contacts.selectBook(name);
    await contacts.createBasicContact(contactName, `book-delete-${suffix}@example.com`);
    await contacts.selectBook(name);
    await contacts.expectContactRow(contactName);
    await contacts.requestBookDelete(name);
    await contacts.expectBookDeleteImpact(1, 0);
    await contacts.confirmBookDelete();
    await contacts.expectBookAbsent(name);

    // Deleting an exclusive book card is permanent; it must not enter Trash.
    await contacts.displayAllContacts();
    await contacts.filter(contactName);
    await contacts.expectContactAbsent(contactName);
    await contacts.selectTrash();
    await contacts.expectContactAbsent(contactName);
  });
});
