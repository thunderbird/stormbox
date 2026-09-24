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
 * Keep this helper limited to test-data maintenance. BrowserStack test
 * actions and assertions should continue to exercise the Stormbox UI.
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
const REQUEST_TIMEOUT_MS = 30_000;

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
  apiUrl: string;
  authHeader: string;
  identityAccountId: string;
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
    apiUrl,
    authHeader,
    identityAccountId: session.primaryAccounts?.[SUBMISSION_CAPABILITY] ?? accountId,
  };
  await verifyExpectedIdentity(client);
  return client;
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
