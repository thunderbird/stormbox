import { randomUUID } from 'node:crypto';

import { test, type BrowserContext, type Page } from '@playwright/test';

import {
  PLAYWRIGHT_TAG_DESKTOP,
  PLAYWRIGHT_TAG_MOBILE,
} from '../const/constants';
import {
  deleteContactsAndAddressBooksByPrefix,
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

test.describe('stormbox address books and contacts', {
  tag: [PLAYWRIGHT_TAG_DESKTOP, PLAYWRIGHT_TAG_MOBILE],
}, () => {
  // With fullyParallel, beforeAll runs for each test even when workers is 1.
  // Default mode keeps this suite's tests in one worker per project, so JMAP
  // cleanup runs once per project unless that worker restarts after a failure.
  test.describe.configure({ mode: 'default' });

  let contacts: ContactsPage;
  let signedIn = false;
  let contactNamesToClean: string[] = [];
  let bookNamesToClean: string[] = [];
  let primaryIdentityVerified = false;
  let trashPurged = false;
  let desktopContext: BrowserContext | undefined;
  let desktopPage: Page | undefined;

  test.use({
    page: async ({ page }, use, testInfo) => {
      // Keep Android on the SDK's per-test page and UI sign-in path. Its
      // device context does not support desktop browser.newContext().
      if (testInfo.project.name.toLowerCase().includes('android')) {
        await use(page);
        return;
      }

      if (!desktopContext) {
        // The fixture page identifies the runner/SDK-managed browser without
        // introducing a desktop browser fixture into Android's device setup.
        const browser = page.context().browser();
        if (!browser) throw new Error('Desktop Contacts tests require a browser-owned context.');

        // Saved auth omits Stormbox's IndexedDB cache. Initial Contacts Trash
        // sync in a cold browser can take almost 90 seconds (88 seconds measured
        // against production), and contact deletion waits for it to finish.
        // Keep this context across the suite to avoid repeating that download
        // for each test. newContext inherits the project's auth and device options:
        // https://playwright.dev/docs/test-use-options#explicit-context-creation-and-option-inheritance
        desktopContext = await browser.newContext();
      }

      // Reset the page UI between cases while retaining the context's cache.
      // Each case still removes its own server-side artifacts in afterEach.
      await desktopPage?.close();
      desktopPage = await desktopContext.newPage();
      await use(desktopPage);
      // Keep the page through fixture teardown so Playwright can capture
      // failure artifacts even when this case's afterEach cleanup fails.
    },
  });

  test.beforeAll(async () => {
    // Sweep cards before books; BrowserStack lanes sharing this account must not overlap.
    await deleteContactsAndAddressBooksByPrefix(CONTACT_PREFIX, BOOK_PREFIX);
  });

  test.beforeEach(async ({ page }, testInfo) => {
    signedIn = false;
    contactNamesToClean = [];
    bookNamesToClean = [];
    const stormbox = new StormboxPage(page);
    contacts = new ContactsPage(page, stormbox, testInfo.project.name);

    const missing = await stormbox.missingRequiredBrowserFeatures();
    test.skip(missing.length > 0,
      `Stormbox cannot run in this browser. Missing: ${missing.join(', ')}.`);

    await stormbox.navigate();

    // Android signs in through the UI; desktop projects use their prepared auth state.
    await stormbox.signInIfNeeded(testInfo.project.name);
    signedIn = true;
    await contacts.open();

    // The first test/signed-in page verifies primary identity matches the provided primary thundermail email
    if (!primaryIdentityVerified) {
      await contacts.assertExpectedPrimaryMailIdentityVisible();
      primaryIdentityVerified = true;
    }

    // The JMAP card sweep leaves recoverable Trash entries; purge them once.
    if (!trashPurged) {
      await contacts.purgeTestTrash();
      trashPurged = true;
    }
    await contacts.displayAllContacts();
  });

  test.afterEach(async () => {
    // Remove only this case's artifacts, including any card it moved to Trash.
    if (signedIn && (contactNamesToClean.length > 0 || bookNamesToClean.length > 0)) {
      await contacts.cleanUpThroughUi(contactNamesToClean, bookNamesToClean);
    }
  });

  test.afterAll(async () => {
    // The context belongs only to this suite/project worker. A worker restart
    // creates a fresh one and repeats the initial cache population.
    await desktopContext?.close();
    desktopContext = undefined;
    desktopPage = undefined;
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
    contactNamesToClean = [initial.name, edited.name];

    await test.step('create and verify all contact details', async () => {
      await contacts.createDetailedContact(initial);
      await contacts.expectDetailedContact({ ...initial, photo: 'png' });
    });

    await test.step('edit the same contact and replace its photo', async () => {
      console.log(`editing contact: ${initial.name}`);
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

  test('deletes a contact', async () => {
    const suffix = uniqueSuffix();
    const name = `${CONTACT_PREFIX}-${suffix}-Delete`;
    const email = `delete-${suffix}@example.com`;
    contactNamesToClean = [name];

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
    contactNamesToClean = [contactName];
    bookNamesToClean = [name, renamed];
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

  test('deletes an address book and its sole contact', async () => {
    const suffix = uniqueSuffix();
    const name = `${BOOK_PREFIX}-${suffix}-Delete`;
    const contactName = `${CONTACT_PREFIX}-${suffix}-DeletedBookMember`;
    contactNamesToClean = [contactName];
    bookNamesToClean = [name];

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
