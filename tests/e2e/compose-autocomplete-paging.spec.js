import { connectJmap } from './helpers/jmap-client.js';
import {
  attachConsoleTail,
  consoleLinesFor,
  expect,
  test,
} from './helpers/shared-session.js';
import {
  localStackEnabled,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import { waitForShellReady } from './helpers/ui.js';

/**
 * A contact the client could only have learned from a second page of the
 * server's list is findable by name from compose (T510, CS-3.1, CS-3.2,
 * CS-4.2).
 *
 * Only a real server can produce this: the page size is the session's own
 * `maxObjectsInGet`, the order of the card list is the server's to choose,
 * and the bug this guards against — a sync that reads one page and stops —
 * looks like a complete, healthy address book from inside the app.
 *
 * The contact searched for is chosen by asking the server which card it puts
 * beyond the first page, rather than by assuming that the last one created
 * sorts last. Nothing in JMAP promises an order for an unsorted query.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

const CARD_PREFIX = 'Pagewalker';
const CARD_DOMAIN = 'paging-e2e.example';
/** How many cards to write per request, well inside any server's set limit. */
const CREATE_CHUNK = 100;
/**
 * How far past one page to fill the list. The margin is not about off-by-one
 * alone: the tail has to hold enough of this run's cards that leftovers from
 * earlier runs cannot occupy all of it.
 */
const OVERFLOW = 12;

async function contactsRequest(jmap, methodCalls) {
  const res = await fetch(jmap.apiUrl, {
    method: 'POST',
    headers: { Authorization: jmap.authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:contacts'],
      methodCalls,
    }),
  });
  if (!res.ok) {
    throw new Error(`contacts JMAP failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  return res.json();
}

/**
 * The page size the client will use: the smaller of its own request size and
 * the server's object limit, which is what the sync clamps to.
 */
const CLIENT_PAGE_SIZE = 500;

function pageLimit(jmap) {
  const core = jmap.session?.capabilities?.['urn:ietf:params:jmap:core'];
  const stated = Number(core?.maxObjectsInGet);
  expect(
    stated > 0,
    'the session must state maxObjectsInGet for this test to mean anything',
  ).toBe(true);
  return Math.min(CLIENT_PAGE_SIZE, stated);
}

async function defaultBookId(jmap) {
  const res = await contactsRequest(jmap, [['AddressBook/get', { accountId: jmap.accountId }, 'a']]);
  const books = res.methodResponses?.[0]?.[1]?.list ?? [];
  const chosen = books.find((b) => b.isDefault) ?? books[0];
  expect(chosen?.id, 'the account needs an address book to file cards in').toBeTruthy();
  return chosen.id;
}

async function createCards(jmap, bookId, cards) {
  const ids = [];
  for (let start = 0; start < cards.length; start += CREATE_CHUNK) {
    const chunk = cards.slice(start, start + CREATE_CHUNK);
    const create = {};
    chunk.forEach((card, index) => {
      create[`c${index}`] = {
        '@type': 'Card',
        version: '1.0',
        addressBookIds: { [bookId]: true },
        name: { full: card.name },
        emails: {
          e1: { '@type': 'EmailAddress', address: card.address },
        },
      };
    });
    const res = await contactsRequest(jmap, [[
      'ContactCard/set', { accountId: jmap.accountId, create }, 's',
    ]]);
    const created = res.methodResponses?.[0]?.[1]?.created ?? {};
    const notCreated = res.methodResponses?.[0]?.[1]?.notCreated ?? {};
    expect(
      Object.keys(notCreated),
      `the server refused cards: ${JSON.stringify(notCreated).slice(0, 400)}`,
    ).toEqual([]);
    for (const key of Object.keys(create)) {
      if (created[key]?.id) ids.push(created[key].id);
    }
  }
  return ids;
}

async function destroyCards(jmap, ids) {
  for (let start = 0; start < ids.length; start += CREATE_CHUNK) {
    await contactsRequest(jmap, [[
      'ContactCard/set',
      { accountId: jmap.accountId, destroy: ids.slice(start, start + CREATE_CHUNK) },
      's',
    ]]).catch(() => {});
  }
}

/**
 * The word this card can be found by, and only by its name.
 *
 * It is deliberately absent from the address: a term the address also
 * contains would be answered by the address match, and the case would pass
 * without the name index ever being consulted (CS-3.2). One word per card,
 * so a hit names exactly which card was found.
 */
function nameOnlyWord(stamp, index) {
  return `zulu${stamp}${String(index).padStart(4, '0')}`;
}

/**
 * A card of this run's that the server sorts past `position`.
 *
 * It has to be one of this run's, because the assertion is made by a word
 * from the name and an older leftover card carries none. And it has to be
 * chosen by asking the server, because nothing in JMAP promises an order
 * for an unsorted query — the card created last is not necessarily the one
 * that lands last.
 */
async function lateCardOfThisRun(jmap, position, stamp) {
  const q = await contactsRequest(jmap, [[
    'ContactCard/query', { accountId: jmap.accountId, position, limit: 50 }, 'q',
  ]]);
  const ids = q.methodResponses?.find((r) => r[0] === 'ContactCard/query')?.[1]?.ids ?? [];
  expect(ids.length, `the server should have cards past position ${position}`).toBeGreaterThan(0);
  const g = await contactsRequest(jmap, [[
    'ContactCard/get', { accountId: jmap.accountId, ids }, 'g',
  ]]);
  const list = g.methodResponses?.find((r) => r[0] === 'ContactCard/get')?.[1]?.list ?? [];
  const mine = list.find((card) => (card?.name?.full ?? '').includes(`zulu${stamp}`));
  expect(
    mine,
    `none of the ${list.length} cards past position ${position} belong to this run; `
    + 'raise OVERFLOW so the tail of the list is this run\'s',
  ).toBeTruthy();
  return { id: mine.id, name: mine.name.full };
}

/** Force the full, authoritative contact sync the app runs at startup. */
function resyncContacts(page) {
  return page.evaluate(async () => {
    const accounts = await globalThis.__repo.listAccounts();
    await globalThis.__repo.ensureContacts(accounts[0].id);
  });
}

test.describe('Autocomplete across contact pages', () => {
  test('a contact from beyond the first server page is found by name', async ({ sharedPage: page }, testInfo) => {
    await page.getByRole('button', { name: 'Mail', exact: true }).click().catch(() => {});
    await waitForShellReady(page);

    const jmap = await connectJmap();
    const limit = pageLimit(jmap);
    const bookId = await defaultBookId(jmap);

    // How many already exist, so the total ends up beyond one page whatever
    // the lane has left behind.
    const existing = await contactsRequest(jmap, [[
      'ContactCard/query', { accountId: jmap.accountId, limit: 1 }, 'q',
    ]]);
    const already = Number(
      existing.methodResponses?.find((r) => r[0] === 'ContactCard/query')?.[1]?.total ?? 0,
    );
    const toCreate = Math.max(0, limit + OVERFLOW - already);
    const stamp = Date.now();
    const cards = Array.from({ length: toCreate }, (_, i) => ({
      name: `${CARD_PREFIX} ${nameOnlyWord(stamp, i)} ${String(i).padStart(4, '0')}`,
      address: `${CARD_PREFIX.toLowerCase()}.${stamp}.${String(i).padStart(4, '0')}@${CARD_DOMAIN}`,
    }));

    let created = [];
    try {
      created = await createCards(jmap, bookId, cards);
      expect(created.length, 'the fixture needs its cards to exist').toBe(toCreate);
      // Without more cards than fit in one page there is no second page, and
      // a one-page sync would satisfy everything below. Said out loud so a
      // fixture that quietly stopped filling the list fails here rather than
      // passing for the wrong reason.
      expect(
        already + created.length,
        `the list must be longer than one page (${limit}) for this case to mean `
        + `anything: ${already} already there, ${created.length} added`,
      ).toBeGreaterThan(limit);

      // Whatever the server's order is, this card is one the client cannot
      // have without asking for a second page.
      const late = await lateCardOfThisRun(jmap, limit + 1, stamp);
      // The word that identifies it by name alone, taken from the card the
      // server actually chose rather than from the one created last.
      const searchTerm = late.name.split(' ').find((word) => word.startsWith('zulu'));
      expect(
        searchTerm,
        `the card at position ${limit + 1} ("${late.name}") should be one of this run's`,
      ).toBeTruthy();

      await resyncContacts(page);
      await expect.poll(
        async () => page.evaluate(async (wanted) => {
          const accounts = await globalThis.__repo.listAccounts();
          const rows = await globalThis.__repo.autocompleteContacts(accounts[0].id, wanted, 10);
          return rows.length;
        }, searchTerm),
        {
          timeout: 120_000,
          message: 'the contact sync should page through the whole list',
        },
      ).toBeGreaterThan(0);

      // Now from the composer, by that name word: it appears nowhere in the
      // address, so only the name index can answer it (CS-3.2).
      await page.keyboard.press('ControlOrMeta+n');
      await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });
      const toField = page.locator('.compose-dialog #compose-to');
      await toField.click();
      await toField.fill(searchTerm);

      const options = page.locator('.compose-dialog #compose-to-listbox [role="option"]');
      await expect(options.first()).toBeVisible({ timeout: 15_000 });
      await expect(
        options.filter({ hasText: late.name }).first(),
        `the late-page contact "${late.name}" should be offered for "${searchTerm}"`,
      ).toBeVisible();
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await page.locator('.compose-dialog header button.icon').click().catch(() => {});
      await destroyCards(jmap, created);
      // Leave the cache as the rest of the lane expects to find it.
      await resyncContacts(page).catch(() => {});
    }
  });
});
