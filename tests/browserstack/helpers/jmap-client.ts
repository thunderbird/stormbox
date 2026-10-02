/**
 * Minimal JMAP client for BrowserStack cleanup against a deployed
 * Thundermail stage or production account.
 *
 * This client deliberately does not share the local-stack JMAP helper in
 * tests/e2e. Deployed Thundermail authenticates these direct JMAP requests
 * with the test account's app password over HTTP Basic authentication; the
 * normal TB Accounts password remains reserved for signing into Stormbox in
 * the browser.
 *
 * Keep this helper limited to test-data maintenance and read-only account
 * metadata checks. BrowserStack UI flows run through Stormbox.
 */

import {
  PRIMARY_THUNDERMAIL_EMAIL,
  STORMBOX_TARGET_ENV,
  THUNDERMAIL_JMAP_APP_PASSWORD,
  THUNDERMAIL_JMAP_URL,
  THUNDERMAIL_JMAP_USERNAME,
} from '../const/constants';

const CORE_CAPABILITY = 'urn:ietf:params:jmap:core';
const MAIL_CAPABILITY = 'urn:ietf:params:jmap:mail';
const SUBMISSION_CAPABILITY = 'urn:ietf:params:jmap:submission';
const CONTACTS_CAPABILITY = 'urn:ietf:params:jmap:contacts';
const REQUEST_TIMEOUT_MS = 30_000;
const CONTACT_PAGE_SIZE = 200;

type JmapMethodCall = [string, Record<string, unknown>, string];
type JmapMethodResponse = [string, Record<string, unknown>, string];

interface JmapPayload {
  methodResponses?: JmapMethodResponse[];
}

interface JmapSession {
  apiUrl?: string;
  primaryAccounts?: Record<string, string>;
}

interface JmapClient {
  accountId: string;
  contactsAccountId?: string;
  apiUrl: string;
  authHeader: string;
  identityAccountId: string;
}

interface JmapContactsClient extends JmapClient {
  contactsAccountId: string;
}

interface JmapMailbox {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
}

/** Read a required setting without including its secret value in an error. */
function requireSetting(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} must be set in tests/browserstack/.env.browserstack`);
  }
  return trimmed;
}

/**
 * Parse one JSON response with normal TLS verification and a finite timeout.
 * Mutating requests are intentionally not retried: a lost response does not
 * prove that the server failed to apply the mutation.
 */
async function fetchJson(url: string, init: RequestInit, description: string): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `${description} failed: ${response.status} ${response.statusText}`
      + (body ? `; response=${body.slice(0, 500)}` : ''),
    );
  }

  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(`${description} returned invalid JSON`, { cause: error });
  }
}

/** Send one JMAP request and surface protocol-level method errors. */
async function jmapRequest(
  client: JmapClient,
  methodCalls: JmapMethodCall[],
  using: string[] = [CORE_CAPABILITY, MAIL_CAPABILITY],
): Promise<JmapPayload> {
  const payload = await fetchJson(
    client.apiUrl,
    {
      method: 'POST',
      headers: {
        Authorization: client.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ using, methodCalls }),
    },
    'JMAP request',
  ) as JmapPayload;

  if (!Array.isArray(payload.methodResponses)) {
    throw new Error('JMAP response did not contain methodResponses');
  }

  const methodError = payload.methodResponses.find(([name]) => name === 'error');
  if (methodError) {
    throw new Error(`JMAP method error: ${JSON.stringify(methodError[1])}`);
  }

  return payload;
}

/** Return the response arguments for a named JMAP method. */
function responseFor(payload: JmapPayload, methodName: string): Record<string, unknown> {
  const response = payload.methodResponses?.find(([name]) => name === methodName);
  if (!response) {
    throw new Error(`JMAP response did not contain ${methodName}`);
  }
  return response[1];
}

/**
 * Confirm that the app password opened the dedicated account expected by the
 * BrowserStack suite before any destructive request is allowed.
 */
async function verifyExpectedIdentity(client: JmapClient): Promise<void> {
  const expectedEmail = requireSetting('PRIMARY_THUNDERMAIL_EMAIL', PRIMARY_THUNDERMAIL_EMAIL)
    .toLowerCase();
  const payload = await jmapRequest(
    client,
    [[
      'Identity/get',
      {
        accountId: client.identityAccountId,
        properties: ['email'],
      },
      'identity',
    ]],
    [CORE_CAPABILITY, SUBMISSION_CAPABILITY],
  );
  const identities = responseFor(payload, 'Identity/get').list;
  const hasExpectedIdentity = Array.isArray(identities) && identities.some((identity) => {
    if (typeof identity !== 'object' || identity == null) return false;
    const email = (identity as Record<string, unknown>).email;
    return typeof email === 'string' && email.toLowerCase() === expectedEmail;
  });

  if (!hasExpectedIdentity) {
    throw new Error(
      `JMAP credentials do not provide the expected ${PRIMARY_THUNDERMAIL_EMAIL} identity; refusing cleanup`,
    );
  }
}

/**
 * Connect to the deployed Thundermail JMAP server with the dedicated test
 * account's app password. This runs in the Node Playwright process, not in
 * the remote BrowserStack browser, so credentials never enter page state.
 */
async function connectJmap(): Promise<JmapClient> {
  const targetEnvironment = requireSetting('STORMBOX_TARGET_ENV', STORMBOX_TARGET_ENV);
  if (targetEnvironment !== 'stage' && targetEnvironment !== 'prod') {
    throw new Error(
      `Direct BrowserStack JMAP cleanup only supports deployed stage or prod environments, not "${targetEnvironment}"`,
    );
  }

  const baseUrl = requireSetting('THUNDERMAIL_JMAP_URL', THUNDERMAIL_JMAP_URL).replace(/\/$/, '');
  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.protocol !== 'https:') {
    throw new Error('THUNDERMAIL_JMAP_URL must use HTTPS for deployed Thundermail cleanup');
  }

  const username = requireSetting('THUNDERMAIL_JMAP_USERNAME', THUNDERMAIL_JMAP_USERNAME);
  const appPassword = requireSetting(
    'THUNDERMAIL_JMAP_APP_PASSWORD',
    THUNDERMAIL_JMAP_APP_PASSWORD,
  );
  const authHeader = `Basic ${Buffer.from(`${username}:${appPassword}`, 'utf8').toString('base64')}`;
  console.log(`connecting directly to the Thundermail JMAP server at ${baseUrl}`);
  const session = await fetchJson(
    `${baseUrl}/.well-known/jmap`,
    { headers: { Authorization: authHeader } },
    'JMAP session discovery',
  ) as JmapSession;

  const accountId = session.primaryAccounts?.[MAIL_CAPABILITY];
  if (!accountId) {
    throw new Error('JMAP session did not advertise a primary mail account');
  }
  if (!session.apiUrl) {
    throw new Error('JMAP session did not advertise an apiUrl');
  }

  // Resolve a relative apiUrl if a conforming proxy returns one, while using
  // the server-advertised origin for normal production sessions.
  const apiUrl = new URL(session.apiUrl, `${baseUrl}/`).toString();
  if (new URL(apiUrl).protocol !== 'https:') {
    throw new Error('The deployed JMAP session advertised a non-HTTPS apiUrl');
  }

  const client: JmapClient = {
    accountId,
    contactsAccountId: session.primaryAccounts?.[CONTACTS_CAPABILITY],
    apiUrl,
    authHeader,
    identityAccountId: session.primaryAccounts?.[SUBMISSION_CAPABILITY] ?? accountId,
  };
  await verifyExpectedIdentity(client);
  return client;
}

async function connectContactsJmap(): Promise<JmapContactsClient> {
  const client = await connectJmap();
  if (!client.contactsAccountId || client.contactsAccountId !== client.accountId
    || client.identityAccountId !== client.accountId) {
    throw new Error('JMAP primary contacts, mail, and identity accounts differ; refusing cleanup');
  }
  return client as JmapContactsClient;
}

interface JmapContactCard {
  id: string;
  name?: { full?: string } | null;
}

interface JmapAddressBook {
  id: string;
  name: string;
  isDefault: boolean;
}

/** Page the complete card inventory and reject an inconsistent query snapshot. */
async function listContactCardIds(client: JmapContactsClient, filter?: Record<string, unknown>): Promise<string[]> {
  const ids: string[] = [];
  let queryState: string | null = null;
  let total: number | null = null;

  while (total == null || ids.length < total) {
    const payload = await jmapRequest(client, [[
      'ContactCard/query',
      {
        accountId: client.contactsAccountId,
        ...(filter ? { filter } : {}),
        position: ids.length,
        limit: CONTACT_PAGE_SIZE,
        calculateTotal: true,
      },
      'contactCards',
    ]], [CORE_CAPABILITY, CONTACTS_CAPABILITY]);
    const result = responseFor(payload, 'ContactCard/query');
    if (typeof result.queryState !== 'string' || !result.queryState
      || !Number.isSafeInteger(result.total) || Number(result.total) < 0
      || result.position !== ids.length || !Array.isArray(result.ids)
      || result.ids.length > CONTACT_PAGE_SIZE
      || result.ids.some((id) => typeof id !== 'string')) {
      throw new Error('ContactCard/query did not return a complete inventory page');
    }
    if (queryState !== null && (queryState !== result.queryState || total !== result.total)) {
      throw new Error('ContactCard/query changed while paging; refusing cleanup');
    }
    queryState = result.queryState;
    total = Number(result.total);
    if (result.ids.length === 0 && ids.length < total) {
      throw new Error('ContactCard/query stopped before the complete inventory was read');
    }
    ids.push(...result.ids as string[]);
  }

  if (ids.length !== total || new Set(ids).size !== ids.length) {
    throw new Error('ContactCard/query returned an incomplete or duplicate inventory');
  }
  return ids;
}

async function listContactCards(client: JmapContactsClient): Promise<JmapContactCard[]> {
  const ids = await listContactCardIds(client);
  const cards: JmapContactCard[] = [];
  for (let offset = 0; offset < ids.length; offset += CONTACT_PAGE_SIZE) {
    const pageIds = ids.slice(offset, offset + CONTACT_PAGE_SIZE);
    const payload = await jmapRequest(client, [[
      'ContactCard/get',
      { accountId: client.contactsAccountId, ids: pageIds, properties: ['id', 'name'] },
      'contactCardDetails',
    ]], [CORE_CAPABILITY, CONTACTS_CAPABILITY]);
    const result = responseFor(payload, 'ContactCard/get');
    if (!Array.isArray(result.list) || result.list.length !== pageIds.length
      || (Array.isArray(result.notFound) && result.notFound.length > 0)) {
      throw new Error('ContactCard/get did not return every queried card');
    }
    for (const card of result.list) {
      if (typeof card !== 'object' || card == null
        || typeof card.id !== 'string'
        || (card.name != null && (typeof card.name !== 'object'
          || (card.name.full != null && typeof card.name.full !== 'string')))) {
        throw new Error('ContactCard/get returned a malformed card');
      }
      cards.push(card as JmapContactCard);
    }
  }
  const expected = new Set(ids);
  if (cards.length !== ids.length || cards.some((card) => !expected.delete(card.id))
    || expected.size !== 0) {
    throw new Error('ContactCard/get returned a mismatched card inventory');
  }
  return cards;
}

/** Remove only named test cards, before test address books are inspected. */
export async function deleteContactsByPrefix(prefix: string): Promise<number> {
  if (prefix !== 'E2E-Contact') {
    throw new Error('Contact cleanup requires the E2E-Contact prefix');
  }
  const client = await connectContactsJmap();
  const matching = (await listContactCards(client))
    .filter((card) => card.name?.full?.startsWith(prefix));
  for (let offset = 0; offset < matching.length; offset += CONTACT_PAGE_SIZE) {
    const ids = matching.slice(offset, offset + CONTACT_PAGE_SIZE).map((card) => card.id);
    const payload = await jmapRequest(client, [[
      'ContactCard/set',
      { accountId: client.contactsAccountId, destroy: ids },
      'deleteContactCards',
    ]], [CORE_CAPABILITY, CONTACTS_CAPABILITY]);
    const result = responseFor(payload, 'ContactCard/set');
    const destroyed = new Set(Array.isArray(result.destroyed) ? result.destroyed : []);
    if (result.notDestroyed && Object.keys(result.notDestroyed).length > 0
      || ids.some((id) => !destroyed.has(id))) {
      throw new Error(`Could not delete test contacts: ${JSON.stringify(result.notDestroyed ?? {})}`);
    }
  }
  if ((await listContactCards(client)).some((card) => card.name?.full?.startsWith(prefix))) {
    throw new Error('JMAP cleanup left matching contacts');
  }
  return matching.length;
}

async function listAddressBooks(client: JmapContactsClient): Promise<JmapAddressBook[]> {
  const payload = await jmapRequest(client, [[
    'AddressBook/get',
    { accountId: client.contactsAccountId, ids: null, properties: ['id', 'name', 'isDefault'] },
    'addressBooks',
  ]], [CORE_CAPABILITY, CONTACTS_CAPABILITY]);
  const list = responseFor(payload, 'AddressBook/get').list;
  if (!Array.isArray(list) || list.some((book) =>
    typeof book !== 'object' || book == null
    || typeof book.id !== 'string' || typeof book.name !== 'string'
    || typeof book.isDefault !== 'boolean')) {
    throw new Error('AddressBook/get did not return valid address books');
  }
  return list as JmapAddressBook[];
}

/** All Contacts can file into an unbadged fallback when JMAP marks no default. */
export async function getContactCreationBook(): Promise<JmapAddressBook | null> {
  const books = await listAddressBooks(await connectContactsJmap());
  const defaults = books.filter((book) => book.isDefault);
  if (defaults.length > 1) {
    throw new Error('The JMAP account has more than one default address book');
  }
  return defaults[0]
    ?? books.find((book) => book.name.trim().toLocaleLowerCase() !== 'trusted senders')
    ?? books[0]
    ?? null;
}

/** Refuse books containing other cards; never destroy their contents implicitly. */
export async function deleteAddressBooksByPrefix(prefix: string): Promise<number> {
  if (prefix !== 'E2E-AddressBook') {
    throw new Error('Address book cleanup requires the E2E-AddressBook prefix');
  }
  const client = await connectContactsJmap();
  const matching = (await listAddressBooks(client))
    .filter((book) => book.name.startsWith(prefix));
  for (const book of matching) {
    if (book.isDefault) {
      throw new Error(`Refusing to delete default address book "${book.name}"`);
    }
    const cardIds = await listContactCardIds(client, { inAddressBook: book.id });
    if (cardIds.length > 0) {
      throw new Error(`Refusing to delete test address book "${book.name}" containing unmatched cards`);
    }
    const payload = await jmapRequest(client, [[
      'AddressBook/set',
      {
        accountId: client.contactsAccountId,
        destroy: [book.id],
        onDestroyRemoveContents: false,
      },
      'deleteAddressBook',
    ]], [CORE_CAPABILITY, CONTACTS_CAPABILITY]);
    const result = responseFor(payload, 'AddressBook/set');
    if (result.notDestroyed && Object.keys(result.notDestroyed).length > 0
      || !Array.isArray(result.destroyed) || !result.destroyed.includes(book.id)) {
      throw new Error(`Could not delete test address book "${book.name}": ${JSON.stringify(result.notDestroyed ?? {})}`);
    }
  }
  if ((await listAddressBooks(client)).some((book) => book.name.startsWith(prefix))) {
    throw new Error('JMAP cleanup left matching address books');
  }
  return matching.length;
}

/** Fetch the complete mailbox tree needed to delete children before parents. */
async function listMailboxes(client: JmapClient): Promise<JmapMailbox[]> {
  const payload = await jmapRequest(client, [[
    'Mailbox/get',
    {
      accountId: client.accountId,
      ids: null,
      properties: ['id', 'name', 'parentId', 'role'],
    },
    'mailboxes',
  ]]);
  const list = responseFor(payload, 'Mailbox/get').list;
  if (!Array.isArray(list)) {
    throw new Error('Mailbox/get response did not contain a mailbox list');
  }

  return list.map((mailbox) => {
    if (typeof mailbox !== 'object' || mailbox == null) {
      throw new Error('Mailbox/get returned a malformed mailbox');
    }
    const row = mailbox as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.name !== 'string') {
      throw new Error('Mailbox/get returned a mailbox without a string id and name');
    }
    return {
      id: row.id,
      name: row.name,
      parentId: typeof row.parentId === 'string' ? row.parentId : null,
      role: typeof row.role === 'string' ? row.role : null,
    };
  });
}

/**
 * Refuse a partial subtree deletion. RFC 8621 requires children to be
 * removed before their parent; an unmatched descendant also indicates that
 * the requested prefix would reach data this cleanup does not own.
 */
function assertMatchingSubtrees(mailboxes: JmapMailbox[], matchingIds: Set<string>): void {
  const byId = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));

  for (const mailbox of mailboxes) {
    if (matchingIds.has(mailbox.id)) continue;
    const seen = new Set<string>();
    let parentId = mailbox.parentId;
    while (parentId) {
      if (matchingIds.has(parentId)) {
        throw new Error(
          `Refusing to delete a matching folder that contains nonmatching child "${mailbox.name}"`,
        );
      }
      if (seen.has(parentId)) {
        throw new Error('Mailbox/get returned a cyclic folder hierarchy');
      }
      seen.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
}

/** Delete one leaf level and require every requested id to succeed. */
async function deleteMailboxIds(client: JmapClient, mailboxes: JmapMailbox[]): Promise<void> {
  const ids = mailboxes.map((mailbox) => mailbox.id);
  const payload = await jmapRequest(client, [[
    'Mailbox/set',
    {
      accountId: client.accountId,
      destroy: ids,
      // Test-created folders should be empty. Preserve mail and surface an
      // unexpected mailboxHasEmail response instead of deleting messages.
      onDestroyRemoveEmails: false,
    },
    'deleteMailboxes',
  ]]);
  const result = responseFor(payload, 'Mailbox/set');
  const notDestroyed = result.notDestroyed;
  if (typeof notDestroyed === 'object' && notDestroyed != null
    && Object.keys(notDestroyed).length > 0) {
    throw new Error(`Could not delete test folders: ${JSON.stringify(notDestroyed)}`);
  }

  const destroyed = new Set(Array.isArray(result.destroyed) ? result.destroyed : []);
  const missing = mailboxes.filter((mailbox) => !destroyed.has(mailbox.id));
  if (missing.length > 0) {
    throw new Error(
      `Mailbox/set did not confirm deletion of: ${missing.map((mailbox) => mailbox.name).join(', ')}`,
    );
  }
}

/**
 * Delete every non-system folder whose name begins with the supplied test
 * prefix, deepest-first, and verify the server no longer returns a match.
 */
export async function deleteFoldersByPrefix(prefix: string): Promise<number> {
  if (!prefix.startsWith('E2E-')) {
    throw new Error('Folder cleanup prefix must begin with "E2E-"');
  }

  const client = await connectJmap();
  const allMailboxes = await listMailboxes(client);
  const matching = allMailboxes.filter((mailbox) => mailbox.name.startsWith(prefix));
  if (matching.length === 0) {
    console.log(`found 0 test folders to clean up with prefix "${prefix}"`);
    return 0;
  }

  const protectedMatch = matching.find((mailbox) => mailbox.role != null);
  if (protectedMatch) {
    throw new Error(
      `Refusing to delete system folder "${protectedMatch.name}" with role "${protectedMatch.role}"`,
    );
  }

  const matchingIds = new Set(matching.map((mailbox) => mailbox.id));
  assertMatchingSubtrees(allMailboxes, matchingIds);
  console.log(`deleting ${matching.length} folder(s) using JMAP`);

  // Delete every current leaf level together, then repeat. This satisfies
  // RFC 8621's mailboxHasChild constraint without relying on server ordering
  // within one Mailbox/set destroy array.
  const remainingTree = new Map(allMailboxes.map((mailbox) => [mailbox.id, mailbox]));
  const remainingMatches = new Map(matching.map((mailbox) => [mailbox.id, mailbox]));
  while (remainingMatches.size > 0) {
    const parentIds = new Set(
      [...remainingTree.values()]
        .map((mailbox) => mailbox.parentId)
        .filter((parentId): parentId is string => parentId != null),
    );
    const leaves = [...remainingMatches.values()]
      .filter((mailbox) => !parentIds.has(mailbox.id));
    if (leaves.length === 0) {
      throw new Error('Could not find a leaf in the matching folder hierarchy');
    }

    console.log(
      `Deleting test folders through JMAP: ${leaves.map((folder) => folder.name).join(', ')}`,
    );
    await deleteMailboxIds(client, leaves);
    for (const leaf of leaves) {
      remainingTree.delete(leaf.id);
      remainingMatches.delete(leaf.id);
    }
  }

  const leftovers = (await listMailboxes(client))
    .filter((mailbox) => mailbox.name.startsWith(prefix));
  if (leftovers.length > 0) {
    throw new Error(
      `JMAP cleanup left matching folders: ${leftovers.map((mailbox) => mailbox.name).join(', ')}`,
    );
  }

  return matching.length;
}
