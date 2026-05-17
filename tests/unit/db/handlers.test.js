import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory.js';
import { makeHandlers, noopBroadcaster } from '../../../src/db/handlers.js';
import { DB_RPC, TABLE_FAMILIES } from '../../../src/db/protocol.js';
import { SERVICE_KIND, FOLDER_ROLE, KEYWORD } from '../../../src/constants/states.js';

let engine;
let broadcaster;
let h;

beforeEach(async () => {
  engine = await bootTestEngine();
  broadcaster = noopBroadcaster();
  h = makeHandlers(engine, broadcaster);
});

afterEach(async () => {
  await engine.close();
});

async function seedAccount(overrides = {}) {
  const result = await h[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'Test User',
    primaryEmail: 'test@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: 'acct-1',
    isPrimary: true,
    ...overrides,
  });
  return result.row;
}

async function seedFolder(accountId, overrides = {}) {
  const remoteId = overrides.remoteId ?? `mb-${Math.random().toString(36).slice(2)}`;
  await h[DB_RPC.FOLDER_UPSERT_MANY]({
    accountId,
    folders: [{
      remoteId,
      name: overrides.name ?? 'Inbox',
      role: overrides.role ?? FOLDER_ROLE.INBOX,
      sortOrder: overrides.sortOrder ?? 0,
      totalEmails: overrides.totalEmails ?? 0,
      unreadEmails: overrides.unreadEmails ?? 0,
      ...overrides,
    }],
  });
  return engine.get(
    'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
    [accountId, remoteId],
  );
}

describe('account handlers', () => {
  it('upserts a fresh account and reads it back', async () => {
    const account = await seedAccount();
    expect(account.display_name).toBe('Test User');
    expect(account.primary_email).toBe('test@example.com');
    expect(account.server_origin).toBe('https://mail.example.com');
    expect(account.remote_account_id).toBe('acct-1');
    expect(Number(account.is_primary)).toBe(1);
  });

  it('updates fields on a second upsert without duplicating the row', async () => {
    await seedAccount();
    await seedAccount({ displayName: 'Renamed', isPrimary: false });
    const list = await h[DB_RPC.ACCOUNT_LIST]();
    expect(list).toHaveLength(1);
    expect(list[0].display_name).toBe('Renamed');
    expect(Number(list[0].is_primary)).toBe(0);
  });

  it('keeps multiple accounts uniquely keyed by (server_origin, remote_account_id)', async () => {
    await seedAccount({ remoteAccountId: 'a' });
    await seedAccount({ remoteAccountId: 'b' });
    await seedAccount({ serverOrigin: 'https://other.example.com', remoteAccountId: 'a' });
    const list = await h[DB_RPC.ACCOUNT_LIST]();
    expect(list).toHaveLength(3);
  });

  it('looks up accounts by remote handle', async () => {
    await seedAccount({ remoteAccountId: 'looked-up' });
    const found = await h[DB_RPC.ACCOUNT_GET_BY_REMOTE]({
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'looked-up',
    });
    expect(found).not.toBeNull();
    expect(found.remote_account_id).toBe('looked-up');
    expect(broadcaster.flush()).toContain(TABLE_FAMILIES.ACCOUNTS);
  });
});

describe('account services and capabilities', () => {
  it('stores one row per (account, service_kind) and updates idempotently', async () => {
    const account = await seedAccount();
    await h[DB_RPC.ACCOUNT_SERVICE_UPSERT]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_MAIL,
      apiUrl: 'https://mail.example.com/jmap',
      websocketUrl: 'wss://mail.example.com/jmap/ws',
      supportsWebsocketPush: true,
      pushState: 'aaa',
    });
    await h[DB_RPC.ACCOUNT_SERVICE_UPSERT]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      apiUrl: 'https://mail.example.com/jmap',
    });
    await h[DB_RPC.ACCOUNT_SERVICE_UPSERT]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_MAIL,
      apiUrl: 'https://mail.example.com/jmap',
      pushState: 'bbb',
    });
    const rows = await engine.all(
      'SELECT * FROM account_services WHERE account_id = ? ORDER BY service_kind',
      [account.id],
    );
    expect(rows.map((r) => r.service_kind)).toEqual([
      SERVICE_KIND.JMAP_CONTACTS,
      SERVICE_KIND.JMAP_MAIL,
    ]);
    const mail = rows.find((r) => r.service_kind === SERVICE_KIND.JMAP_MAIL);
    expect(mail.push_state).toBe('bbb');
  });

  it('replaces capabilities atomically per (account, service_kind)', async () => {
    const account = await seedAccount();
    await h[DB_RPC.ACCOUNT_CAPABILITIES_REPLACE]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_MAIL,
      capabilities: {
        'urn:ietf:params:jmap:core': { maxConcurrentRequests: 4 },
        'urn:ietf:params:jmap:mail': { maxMailboxesPerEmail: null },
      },
    });
    let rows = await engine.all(
      'SELECT capability FROM account_capabilities WHERE account_id = ? ORDER BY capability',
      [account.id],
    );
    expect(rows).toHaveLength(2);

    await h[DB_RPC.ACCOUNT_CAPABILITIES_REPLACE]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_MAIL,
      capabilities: { 'urn:ietf:params:jmap:websocket': { url: 'wss://...', supportsPush: true } },
    });
    rows = await engine.all(
      'SELECT capability FROM account_capabilities WHERE account_id = ?',
      [account.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].capability).toBe('urn:ietf:params:jmap:websocket');
  });
});

describe('folder handlers', () => {
  it('upserts and lists folders in tree order', async () => {
    const account = await seedAccount();
    await h[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [
        { remoteId: 'mb-inbox', name: 'Inbox', role: 'inbox', sortOrder: 0 },
        { remoteId: 'mb-archive', name: 'Archive', role: 'archive', sortOrder: 10 },
        { remoteId: 'mb-trash', name: 'Trash', role: 'trash', sortOrder: 20 },
      ],
    });
    const list = await h[DB_RPC.FOLDER_LIST]({ accountId: account.id });
    expect(list.map((f) => f.role)).toEqual(['inbox', 'archive', 'trash']);
  });

  it('finds the inbox by role using the partial index', async () => {
    const account = await seedAccount();
    await seedFolder(account.id, { remoteId: 'mb-inbox', name: 'Inbox', role: 'inbox' });
    await seedFolder(account.id, { remoteId: 'mb-foo', name: 'Project Foo', role: null });
    const inbox = await h[DB_RPC.FOLDER_BY_ROLE]({ accountId: account.id, role: 'inbox' });
    expect(inbox).not.toBeNull();
    expect(inbox.name).toBe('Inbox');
  });

  it('omits soft-deleted folders by default', async () => {
    const account = await seedAccount();
    await h[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [
        { remoteId: 'mb-keep', name: 'Keep', isDeleted: false },
        { remoteId: 'mb-deleted', name: 'Old', isDeleted: true },
      ],
    });
    const visible = await h[DB_RPC.FOLDER_LIST]({ accountId: account.id });
    expect(visible.map((f) => f.remote_id)).toEqual(['mb-keep']);
    const all = await h[DB_RPC.FOLDER_LIST]({ accountId: account.id, includeDeleted: true });
    expect(all).toHaveLength(2);
  });
});

describe('identity handlers', () => {
  it('upserts identities and lists them sorted', async () => {
    const account = await seedAccount();
    await h[DB_RPC.IDENTITY_UPSERT_MANY]({
      accountId: account.id,
      identities: [
        { remoteId: 'id-2', name: 'Bob', email: 'bob@example.com' },
        { remoteId: 'id-1', name: 'Alice', email: 'alice@example.com' },
      ],
    });
    const list = await h[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    expect(list.map((i) => i.name)).toEqual(['Alice', 'Bob']);
  });
});

describe('thread + message + membership handlers', () => {
  async function seedMessage(accountId, folderId, overrides = {}) {
    const remoteId = overrides.remoteId ?? `m-${Math.random().toString(36).slice(2)}`;
    await h[DB_RPC.THREAD_UPSERT_MANY]({
      accountId,
      threads: [{ remoteId: overrides.remoteThreadId ?? 't-default', latestReceivedAt: overrides.receivedAt ?? Date.now() }],
    });
    const threadRow = await engine.get(
      'SELECT id FROM threads WHERE account_id = ? AND remote_id = ?',
      [accountId, overrides.remoteThreadId ?? 't-default'],
    );
    await h[DB_RPC.MESSAGE_UPSERT_MANY]({
      accountId,
      messages: [{
        remoteId,
        threadId: threadRow.id,
        remoteThreadId: overrides.remoteThreadId ?? 't-default',
        rfc822MessageId: overrides.rfc822MessageId ?? `<${remoteId}@example.com>`,
        subject: overrides.subject ?? `Subject ${remoteId}`,
        preview: overrides.preview ?? 'preview text',
        size: overrides.size ?? 1234,
        receivedAt: overrides.receivedAt ?? Date.now(),
        sentAt: overrides.sentAt ?? overrides.receivedAt ?? Date.now(),
        hasAttachment: overrides.hasAttachment ?? false,
        keywordsJson: overrides.keywordsJson ?? '{}',
        keywords: overrides.keywords ?? [],
        isSeen: overrides.isSeen ?? false,
        isFlagged: overrides.isFlagged ?? false,
        isAnswered: false,
        isDraft: false,
        isForwarded: false,
        isJunk: false,
        fromText: overrides.fromText ?? 'From <from@example.com>',
        toText: overrides.toText ?? 'To <to@example.com>',
        addresses: overrides.addresses ?? [
          { kind: 'from', position: 0, name: 'From', email: 'from@example.com' },
          { kind: 'to', position: 0, name: 'To', email: 'to@example.com' },
        ],
        metadataFetchedAt: Date.now(),
      }],
    });
    const msgRow = await engine.get(
      'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
      [accountId, remoteId],
    );
    await h[DB_RPC.FOLDER_MEMBERSHIP_REPLACE]({
      accountId,
      messageId: msgRow.id,
      memberships: [{
        folderId,
        sortReceivedAt: overrides.receivedAt ?? Date.now(),
        sortSentAt: overrides.sentAt ?? overrides.receivedAt ?? Date.now(),
      }],
    });
    return { messageId: msgRow.id, threadId: threadRow.id };
  }

  it('lists messages for a folder newest-first', async () => {
    const account = await seedAccount();
    const inbox = await seedFolder(account.id, { remoteId: 'inbox', name: 'Inbox', role: 'inbox' });
    const t = Date.now();
    await seedMessage(account.id, inbox.id, { remoteId: 'old', receivedAt: t - 10_000 });
    await seedMessage(account.id, inbox.id, { remoteId: 'new', receivedAt: t });

    const rows = await h[DB_RPC.MESSAGE_LIST_FOR_FOLDER]({ folderId: inbox.id });
    expect(rows).toHaveLength(2);
    expect(rows[0].remote_id).toBe('new');
    expect(rows[1].remote_id).toBe('old');
  });

  it('looks up messages by RFC 5322 Message-Id within an account', async () => {
    const account = await seedAccount();
    const inbox = await seedFolder(account.id);
    await seedMessage(account.id, inbox.id, { remoteId: 'm1', rfc822MessageId: '<deadbeef@example.com>' });
    const found = await h[DB_RPC.MESSAGE_FIND_BY_RFC822_MESSAGE_ID]({
      accountId: account.id,
      rfc822MessageId: '<deadbeef@example.com>',
    });
    expect(found.remote_id).toBe('m1');
  });

  it('groups thread members by thread_id ordered chronologically', async () => {
    const account = await seedAccount();
    const inbox = await seedFolder(account.id);
    const t = Date.now();
    const a = await seedMessage(account.id, inbox.id, {
      remoteId: 'a',
      remoteThreadId: 'thr-1',
      receivedAt: t - 1000,
    });
    await seedMessage(account.id, inbox.id, {
      remoteId: 'b',
      remoteThreadId: 'thr-1',
      receivedAt: t,
    });
    const rows = await h[DB_RPC.MESSAGE_LIST_FOR_THREAD]({ threadId: a.threadId });
    expect(rows.map((m) => m.remote_id)).toEqual(['a', 'b']);
  });

  it('replaces folder membership atomically', async () => {
    const account = await seedAccount();
    const inbox = await seedFolder(account.id, { remoteId: 'inbox', role: 'inbox' });
    const archive = await seedFolder(account.id, { remoteId: 'archive', role: 'archive' });
    const t = Date.now();
    const { messageId } = await seedMessage(account.id, inbox.id, { remoteId: 'm1', receivedAt: t });

    let inboxMessages = await h[DB_RPC.MESSAGE_LIST_FOR_FOLDER]({ folderId: inbox.id });
    expect(inboxMessages).toHaveLength(1);

    await h[DB_RPC.FOLDER_MEMBERSHIP_REPLACE]({
      accountId: account.id,
      messageId,
      memberships: [{ folderId: archive.id, sortReceivedAt: t, sortSentAt: t }],
    });

    inboxMessages = await h[DB_RPC.MESSAGE_LIST_FOR_FOLDER]({ folderId: inbox.id });
    expect(inboxMessages).toHaveLength(0);
    const archived = await h[DB_RPC.MESSAGE_LIST_FOR_FOLDER]({ folderId: archive.id });
    expect(archived).toHaveLength(1);
  });

  it('mirrors keywords to flag columns and rebuilds message_keywords on replace', async () => {
    const account = await seedAccount();
    const inbox = await seedFolder(account.id);
    const { messageId } = await seedMessage(account.id, inbox.id, { remoteId: 'm1' });

    await h[DB_RPC.MESSAGE_REPLACE_KEYWORDS]({
      messageId,
      keywords: [KEYWORD.SEEN, KEYWORD.FLAGGED, 'work'],
      keywordsJson: JSON.stringify({ [KEYWORD.SEEN]: true, [KEYWORD.FLAGGED]: true, work: true }),
    });

    const row = await engine.get('SELECT is_seen, is_flagged, is_answered, keywords_json FROM messages WHERE id = ?', [messageId]);
    expect(Number(row.is_seen)).toBe(1);
    expect(Number(row.is_flagged)).toBe(1);
    expect(Number(row.is_answered)).toBe(0);

    const kw = await engine.all('SELECT keyword FROM message_keywords WHERE message_id = ? ORDER BY keyword', [messageId]);
    expect(kw.map((k) => k.keyword)).toEqual(['$flagged', '$seen', 'work']);

    await h[DB_RPC.MESSAGE_REPLACE_KEYWORDS]({
      messageId,
      keywords: [KEYWORD.SEEN],
      keywordsJson: JSON.stringify({ [KEYWORD.SEEN]: true }),
    });
    const remaining = await engine.all('SELECT keyword FROM message_keywords WHERE message_id = ?', [messageId]);
    expect(remaining.map((k) => k.keyword)).toEqual(['$seen']);
  });

  it('supports many-to-many folder membership for one message', async () => {
    const account = await seedAccount();
    const inbox = await seedFolder(account.id, { remoteId: 'inbox', role: 'inbox' });
    const work = await seedFolder(account.id, { remoteId: 'work', role: null, name: 'Work' });
    const t = Date.now();
    const { messageId } = await seedMessage(account.id, inbox.id, { remoteId: 'm1', receivedAt: t });
    await h[DB_RPC.FOLDER_MEMBERSHIP_REPLACE]({
      accountId: account.id,
      messageId,
      memberships: [
        { folderId: inbox.id, sortReceivedAt: t, sortSentAt: t },
        { folderId: work.id, sortReceivedAt: t, sortSentAt: t },
      ],
    });
    const a = await h[DB_RPC.MESSAGE_LIST_FOR_FOLDER]({ folderId: inbox.id });
    const b = await h[DB_RPC.MESSAGE_LIST_FOR_FOLDER]({ folderId: work.id });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].id).toBe(b[0].id);
  });

  it('reads positionally from a stored Email/query view (offset 200/limit 50 over 250 items)', async () => {
    // Why this test exists:
    // MESSAGE_LIST_FOR_FOLDER reads via SQL OFFSET over folder_messages
    // and only works when the cache is densely populated from position 0.
    // The deep-scroll path needs MESSAGE_LIST_FOR_VIEW which reads
    // query_view_items.position directly, so it returns the right rows
    // for any window the JMAP layer has actually persisted -- including
    // pages we never put into folder_messages because the user never
    // scrolled through them.
    const account = await seedAccount();
    const archives = await seedFolder(account.id, {
      remoteId: 'mb-archive',
      name: 'Archives',
      role: 'archive',
    });

    const total = 250;
    const pageOffset = 200;
    const pageLimit = 50;
    const t0 = 1_700_000_000_000;

    // Insert 250 messages without folder_messages rows: this is the
    // shape the cache takes after we've fetched a deep page from JMAP
    // but never fetched the early pages, so OFFSET reads would return
    // nothing.
    const messages = Array.from({ length: total }, (_, i) => ({
      remoteId: `e-${String(i).padStart(4, '0')}`,
      remoteThreadId: `t-${i}`,
      subject: `Message #${i}`,
      preview: `preview ${i}`,
      receivedAt: t0 - i * 1000,
      sentAt: t0 - i * 1000,
      keywordsJson: '{}',
      keywords: [],
      isSeen: false,
      isFlagged: false,
      isAnswered: false,
      isDraft: false,
      isForwarded: false,
      isJunk: false,
      addresses: [],
    }));
    await h[DB_RPC.THREAD_UPSERT_MANY]({
      accountId: account.id,
      threads: messages.map((m) => ({ remoteId: m.remoteThreadId })),
    });
    await h[DB_RPC.MESSAGE_UPSERT_MANY]({ accountId: account.id, messages });

    // Hand-write a query_views row matching what
    // sync/backends/jmap/messages.js#upsertQueryView would produce, plus
    // the matching query_view_items rows for positions 0..249. The
    // strings have to byte-for-byte match the production writer; that's
    // exactly the contract MESSAGE_LIST_FOR_VIEW relies on.
    const filterJson = JSON.stringify({ inMailbox: archives.remote_id });
    const sortJson = JSON.stringify([{ property: 'receivedAt', isAscending: false }]);
    await h[DB_RPC.QUERY]({
      sql: `INSERT INTO query_views(
              account_id, view_type, folder_id, filter_json, sort_json,
              collapse_threads, query_state, can_calculate_changes, total,
              created_at, updated_at, last_accessed_at
            ) VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?)`,
      params: [
        account.id, 'mailbox-window', archives.id, filterJson, sortJson,
        'qs-1', total, Date.now(), Date.now(), Date.now(),
      ],
    });
    const viewRow = await engine.get(
      `SELECT id FROM query_views WHERE account_id = ? AND folder_id = ? AND view_type = 'mailbox-window'`,
      [account.id, archives.id],
    );
    await h[DB_RPC.TRANSACTION]({
      statements: messages.map((m, i) => ({
        sql: `INSERT INTO query_view_items(view_id, position, message_id, remote_id)
              VALUES (?, ?, NULL, ?)`,
        params: [viewRow.id, i, m.remoteId],
      })),
    });

    const rows = await h[DB_RPC.MESSAGE_LIST_FOR_VIEW]({
      accountId: account.id,
      folderId: archives.id,
      sort: 'received',
      offset: pageOffset,
      limit: pageLimit,
    });
    expect(rows).toHaveLength(pageLimit);
    expect(rows[0].view_position).toBe(pageOffset);
    expect(rows.at(-1).view_position).toBe(pageOffset + pageLimit - 1);
    expect(rows[0].remote_id).toBe(`e-${String(pageOffset).padStart(4, '0')}`);
    expect(rows.at(-1).remote_id).toBe(`e-${String(pageOffset + pageLimit - 1).padStart(4, '0')}`);
    // And confirm the other reader returns NOTHING for the same offset
    // when the cache is sparse, which is the bug we're fixing.
    const sparse = await h[DB_RPC.MESSAGE_LIST_FOR_FOLDER]({
      folderId: archives.id, offset: pageOffset, limit: pageLimit,
    });
    expect(sparse).toHaveLength(0);
  });
});

describe('contacts and autocomplete', () => {
  it('upserts addressbooks with service_kind discriminator', async () => {
    const account = await seedAccount();
    await h[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', name: 'Default', isDefault: true }],
    });
    await h[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.CARDDAV,
      addressbooks: [{ remoteId: '/carddav/abc/', name: 'Personal', isDefault: false }],
    });
    const list = await h[DB_RPC.ADDRESSBOOK_LIST]({ accountId: account.id });
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe('Default');
  });

  it('upserts contacts with their email rows replaced on each call', async () => {
    const account = await seedAccount();
    await h[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', name: 'Default', isDefault: true }],
    });
    const ab = await engine.get(
      'SELECT id FROM addressbooks WHERE account_id = ? AND remote_id = ?',
      [account.id, 'ab-default'],
    );
    await h[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts: [
        {
          addressbookId: ab.id,
          remoteId: 'c-1',
          fullName: 'Jane Doe',
          displayName: 'Jane Doe',
          givenName: 'Jane',
          familyName: 'Doe',
          emails: [
            { email: 'Jane@Example.com', label: 'home', isPreferred: true },
            { email: 'jane.doe@work.example.com', label: 'work' },
          ],
        },
      ],
    });
    let rows = await engine.all(
      'SELECT email_lower FROM contact_emails WHERE contact_id = (SELECT id FROM contacts WHERE remote_id = ?) ORDER BY position',
      ['c-1'],
    );
    expect(rows.map((r) => r.email_lower)).toEqual(['jane@example.com', 'jane.doe@work.example.com']);

    await h[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts: [
        {
          addressbookId: ab.id,
          remoteId: 'c-1',
          fullName: 'Jane Doe',
          displayName: 'Jane Doe',
          emails: [{ email: 'jane@new.example.com' }],
        },
      ],
    });
    rows = await engine.all(
      'SELECT email_lower FROM contact_emails WHERE contact_id = (SELECT id FROM contacts WHERE remote_id = ?)',
      ['c-1'],
    );
    expect(rows.map((r) => r.email_lower)).toEqual(['jane@new.example.com']);
  });

  it('autocompletes from contacts and message-history with case-insensitive prefix', async () => {
    const account = await seedAccount();
    await h[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', isDefault: true, name: 'Default' }],
    });
    const ab = await engine.get('SELECT id FROM addressbooks WHERE remote_id = ?', ['ab-default']);
    await h[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts: [
        {
          addressbookId: ab.id,
          remoteId: 'c-jane',
          displayName: 'Jane Doe',
          emails: [{ email: 'Jane@Example.com', isPreferred: true }],
        },
        {
          addressbookId: ab.id,
          remoteId: 'c-jay',
          displayName: 'Jay',
          emails: [{ email: 'jay@example.com' }],
        },
      ],
    });

    const inbox = await seedFolder(account.id);
    await h[DB_RPC.MESSAGE_UPSERT_MANY]({
      accountId: account.id,
      messages: [{
        remoteId: 'm-from-history',
        threadId: null,
        rfc822MessageId: '<x@example.com>',
        subject: 'history',
        receivedAt: Date.now(),
        keywordsJson: '{}',
        keywords: [],
        addresses: [
          { kind: 'from', position: 0, name: 'Jasmine', email: 'jasmine@history.example' },
        ],
        metadataFetchedAt: Date.now(),
      }],
    });

    const matches = await h[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: account.id,
      prefix: 'ja',
      limit: 10,
    });
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const emails = matches.map((m) => m.email);
    expect(emails).toContain('Jane@Example.com');
    const sources = new Set(matches.map((m) => m.source));
    expect(sources.has('contact')).toBe(true);
    expect(sources.has('history')).toBe(true);
  });
});

describe('sync state, sync jobs, pending mutations', () => {
  it('round-trips sync_states keyed by (account, type, scope)', async () => {
    const account = await seedAccount();
    await h[DB_RPC.SYNC_STATE_SET]({
      accountId: account.id,
      objectType: 'Email',
      state: 's1',
    });
    let row = await h[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'Email',
    });
    expect(row.state).toBe('s1');

    await h[DB_RPC.SYNC_STATE_SET]({
      accountId: account.id,
      objectType: 'Email',
      scope: 'mailbox-1',
      state: 'queryState-A',
    });
    row = await h[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'Email',
      scope: 'mailbox-1',
    });
    expect(row.state).toBe('queryState-A');

    const accountWide = await h[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'Email',
    });
    expect(accountWide.state).toBe('s1');
  });

  it('inserts sync jobs and returns them in priority order', async () => {
    const account = await seedAccount();
    await h[DB_RPC.SYNC_JOB_INSERT]({
      accountId: account.id,
      jobType: 'mailbox-sync',
      priority: 1,
      payloadJson: JSON.stringify({}),
    });
    await h[DB_RPC.SYNC_JOB_INSERT]({
      accountId: account.id,
      jobType: 'thread-sync',
      priority: 5,
      payloadJson: JSON.stringify({}),
    });
    const batch = await h[DB_RPC.SYNC_JOB_NEXT_BATCH]({ now: Date.now() + 60_000 });
    expect(batch).toHaveLength(2);
    expect(batch[0].job_type).toBe('thread-sync');
  });

  it('respects not_before when picking jobs', async () => {
    const account = await seedAccount();
    const future = Date.now() + 60_000;
    await h[DB_RPC.SYNC_JOB_INSERT]({
      accountId: account.id,
      jobType: 'delayed',
      priority: 10,
      notBefore: future,
      payloadJson: JSON.stringify({}),
    });
    const now = await h[DB_RPC.SYNC_JOB_NEXT_BATCH]({ now: Date.now() });
    expect(now).toHaveLength(0);
    const later = await h[DB_RPC.SYNC_JOB_NEXT_BATCH]({ now: future });
    expect(later).toHaveLength(1);
  });

  it('inserts pending mutations and lists pending/retry rows', async () => {
    const account = await seedAccount();
    await h[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: 'setSeen',
      requestJson: JSON.stringify({ messageId: 'm1' }),
      optimisticPatchJson: JSON.stringify({ is_seen: 1 }),
    });
    await h[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: 'send',
      requestJson: JSON.stringify({ subject: 'Hi' }),
      localStatus: 'retry',
    });
    const rows = await h[DB_RPC.PENDING_MUTATION_LIST_PENDING]({ accountId: account.id });
    expect(rows.map((r) => r.mutation_type).sort()).toEqual(['send', 'setSeen']);
  });
});

describe('index usage on the canonical query patterns', () => {
  it('uses folder_messages_by_folder_received for the inbox window', async () => {
    const account = await seedAccount();
    const inbox = await seedFolder(account.id, { remoteId: 'inbox', role: 'inbox' });
    const plan = await engine.all(
      `EXPLAIN QUERY PLAN
        SELECT m.*, fm.sort_received_at AS sort_key
          FROM folder_messages fm
          JOIN messages m ON m.id = fm.message_id
         WHERE fm.folder_id = ?
         ORDER BY fm.sort_received_at DESC, fm.message_id DESC
         LIMIT 100`,
      [inbox.id],
    );
    const detail = plan.map((row) => row.detail).join(' | ');
    expect(detail).toMatch(/folder_messages_by_folder_received/);
  });

  it('uses messages_thread for the conversation view', async () => {
    const plan = await engine.all(
      `EXPLAIN QUERY PLAN
        SELECT * FROM messages WHERE thread_id = ? ORDER BY received_at ASC, id ASC`,
      [1],
    );
    const detail = plan.map((row) => row.detail).join(' | ');
    expect(detail).toMatch(/messages_thread/);
  });

  it('uses contact_emails_lookup for autocomplete prefix scans', async () => {
    const account = await seedAccount();
    await h[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', isDefault: true, name: 'Default' }],
    });
    const ab = await engine.get('SELECT id FROM addressbooks WHERE remote_id = ?', ['ab-default']);
    const seed = [];
    for (let i = 0; i < 50; i += 1) {
      seed.push({
        addressbookId: ab.id,
        remoteId: `c-${i}`,
        displayName: `Person ${i}`,
        emails: [{ email: `person${i}@example.com` }],
      });
    }
    await h[DB_RPC.CONTACT_UPSERT_MANY]({ accountId: account.id, contacts: seed });
    await engine.exec('ANALYZE');

    // The handler uses a half-open range scan against email_lower so the
    // planner can use contact_emails_lookup unconditionally. The exact
    // entry point (account-led vs email-led) is up to the optimiser, but
    // there must not be a full SCAN of either table.
    const planAccountScoped = await engine.all(
      `EXPLAIN QUERY PLAN
        SELECT c.display_name, ce.email FROM contact_emails ce
          JOIN contacts c ON c.id = ce.contact_id
         WHERE c.account_id = ?
           AND c.is_deleted = 0
           AND ce.email_lower >= ?
           AND ce.email_lower < ?`,
      [account.id, 'pers', 'pert'],
    );
    const accountDetail = planAccountScoped.map((row) => row.detail).join(' | ');
    expect(accountDetail).not.toMatch(/SCAN contact_emails\b(?! USING)/i);
    expect(accountDetail).not.toMatch(/SCAN contacts\b(?! USING)/i);

    // The email-only path used by autocomplete fall-throughs MUST hit
    // contact_emails_lookup - there is no other reasonable plan.
    const planEmailOnly = await engine.all(
      `EXPLAIN QUERY PLAN
        SELECT contact_id FROM contact_emails
         WHERE email_lower >= ? AND email_lower < ?`,
      ['pers', 'pert'],
    );
    const emailDetail = planEmailOnly.map((row) => row.detail).join(' | ');
    expect(emailDetail).toMatch(/contact_emails_lookup/);
  });

  it('uses messages_account_msgid for Message-Id dedup lookups', async () => {
    const plan = await engine.all(
      `EXPLAIN QUERY PLAN
        SELECT id FROM messages WHERE account_id = ? AND rfc822_message_id = ?`,
      [1, '<x@example.com>'],
    );
    const detail = plan.map((row) => row.detail).join(' | ');
    expect(detail).toMatch(/messages_account_msgid/);
  });

  it('uses messages_account_attachment_received for the has-attachment filter', async () => {
    const plan = await engine.all(
      `EXPLAIN QUERY PLAN
        SELECT * FROM messages
         WHERE account_id = ? AND has_attachment = 1
         ORDER BY received_at DESC`,
      [1],
    );
    const detail = plan.map((row) => row.detail).join(' | ');
    expect(detail).toMatch(/messages_account_attachment_received/);
  });
});
