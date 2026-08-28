import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { CONTACT_ADDRESS_PREFIX_SQL } from '../../../src/db/autocomplete';
import { makeHandlers, noopBroadcaster } from '../../../src/db/handlers';
import { DB_RPC, TABLE_FAMILIES } from '../../../src/db/protocol';
import { SERVICE_KIND } from '../../../src/constants/states';

let engine;
let broadcaster;
let h;

beforeEach(async () => {
  engine = await bootTestEngine();
  broadcaster = noopBroadcaster();
  h = makeHandlers(engine, broadcaster);
});

describe('accepted send trusted-recipient effect', () => {
  it('checkpoints acceptance and queues trust atomically', async () => {
    const account = await seedAccount();
    const inserted = await h[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: 'send',
      requestJson: '{}',
    });
    const checkpoint = {
      operationId: 'op',
      messageId: '<op@example.com>',
      emailRemoteId: 'email',
      submissionRemoteId: 'submission',
      cacheAttempts: 0,
      trustedRecipientsQueued: false,
    };
    const saved = await h[DB_RPC.SEND_ACCEPT_AND_QUEUE_TRUST]({
      accountId: account.id,
      rowId: inserted.id,
      checkpoint,
      senders: [{ email: 'recipient@example.com', sourceSentAt: 10 }],
    });

    expect(saved.trustedRecipientsQueued).toBe(true);
    expect(await engine.get(
      `SELECT phase, server_response_json FROM pending_mutations WHERE id = ?`,
      [inserted.id],
    )).toMatchObject({ phase: 'submitted' });
    expect(await engine.get(
      `SELECT COUNT(*) AS count FROM pending_mutations
        WHERE mutation_type = 'whitelistSender'`,
    )).toEqual({ count: 1 });

    await expect(h[DB_RPC.SEND_ACCEPT_AND_QUEUE_TRUST]({
      accountId: account.id,
      rowId: 999_999,
      checkpoint,
      senders: [{ email: 'must-rollback@example.com' }],
    })).rejects.toThrow(/not found/);
    expect(await engine.get(
      `SELECT COUNT(*) AS count FROM pending_mutations
        WHERE mutation_type = 'whitelistSender'`,
    )).toEqual({ count: 1 });
  });
});

afterEach(async () => {
  await engine.close();
});

async function seedAccount(overrides: any = {}) {
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

async function seedFolder(accountId: number, overrides: any = {}) {
  const remoteId = overrides.remoteId ?? `mb-${Math.random().toString(36).slice(2)}`;
  await h[DB_RPC.FOLDER_UPSERT_MANY]({
    accountId,
    folders: [{
      remoteId,
      name: overrides.name ?? 'Inbox',
      role: overrides.role ?? 'inbox',
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
  async function seedMessage(accountId: number, folderId: number, overrides: any = {}) {
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

  it('reports no drift when there is no query view for the folder yet', async () => {
    // A folder we have never opened has no mailbox-window query view
    // row. Membership counts are still reported so the store can use
    // them later if needed, but queryViewExists=false tells the store
    // not to treat this as drift — it just means the first
    // ensureFolderWindow hasn't fired yet.
    const account = await seedAccount();
    const archive = await seedFolder(account.id, { remoteId: 'archive', name: 'Archive', role: 'archive' });
    const t = Date.now();
    await seedMessage(account.id, archive.id, { remoteId: 'archive-1', receivedAt: t });
    await seedMessage(account.id, archive.id, { remoteId: 'archive-2', receivedAt: t - 1_000, isSeen: true });

    const snapshot = await h[DB_RPC.FOLDER_VIEW_CONSISTENCY]({
      accountId: account.id,
      folderId: archive.id,
    });

    expect(snapshot.queryViewExists).toBe(false);
    expect(snapshot.queryViewTotal).toBe(0);
    expect(snapshot.membershipTotal).toBe(2);
    expect(snapshot.membershipUnread).toBe(1);
  });

  it('reports drift when folder_messages has more rows than the query view total', async () => {
    // The Inbox-shows-14-but-membership-knows-72 scenario: a stale
    // mailbox-window total under-counts what folder_messages already
    // has. The mail-store uses this to rebuild the canonical view
    // from JMAP rather than render an impossible hybrid count.
    const account = await seedAccount();
    const archive = await seedFolder(account.id, { remoteId: 'archive', name: 'Archive', role: 'archive' });
    const t = Date.now();
    await seedMessage(account.id, archive.id, { remoteId: 'archive-1', receivedAt: t, isSeen: false });
    await seedMessage(account.id, archive.id, { remoteId: 'archive-2', receivedAt: t - 1_000, isSeen: false });
    await seedMessage(account.id, archive.id, { remoteId: 'archive-3', receivedAt: t - 2_000, isSeen: false });

    // Plant a mailbox-window query view that claims only 1 message
    // exists, matching the production writer's filter/sort JSON so
    // FOLDER_VIEW_CONSISTENCY can find it.
    const filterJson = JSON.stringify({ inMailbox: archive.remote_id });
    const sortJson = JSON.stringify([{ property: 'receivedAt', isAscending: false }]);
    await h[DB_RPC.QUERY]({
      sql: `INSERT INTO query_views(
              account_id, view_type, folder_id, filter_json, sort_json,
              collapse_threads, query_state, can_calculate_changes, total,
              created_at, updated_at, last_accessed_at
            ) VALUES (?, 'mailbox-window', ?, ?, ?, 0, ?, 1, ?, ?, ?, ?)`,
      params: [
        account.id, archive.id, filterJson, sortJson,
        'qs-stale', 1, Date.now(), Date.now(), Date.now(),
      ],
    });

    const snapshot = await h[DB_RPC.FOLDER_VIEW_CONSISTENCY]({
      accountId: account.id,
      folderId: archive.id,
    });

    expect(snapshot.queryViewExists).toBe(true);
    expect(snapshot.queryViewTotal).toBe(1);
    expect(snapshot.membershipTotal).toBe(3);
    expect(snapshot.membershipUnread).toBe(3);
    // Caller can detect drift by either of these:
    expect(snapshot.membershipTotal).toBeGreaterThan(snapshot.queryViewTotal);
    expect(snapshot.membershipUnread).toBeGreaterThan(snapshot.queryViewTotal);
  });

  it('reports no drift when the query view total matches folder membership', async () => {
    const account = await seedAccount();
    const archive = await seedFolder(account.id, { remoteId: 'archive', name: 'Archive', role: 'archive' });
    const t = Date.now();
    await seedMessage(account.id, archive.id, { remoteId: 'archive-1', receivedAt: t });
    await seedMessage(account.id, archive.id, { remoteId: 'archive-2', receivedAt: t - 1_000, isSeen: true });

    const filterJson = JSON.stringify({ inMailbox: archive.remote_id });
    const sortJson = JSON.stringify([{ property: 'receivedAt', isAscending: false }]);
    await h[DB_RPC.QUERY]({
      sql: `INSERT INTO query_views(
              account_id, view_type, folder_id, filter_json, sort_json,
              collapse_threads, query_state, can_calculate_changes, total,
              created_at, updated_at, last_accessed_at
            ) VALUES (?, 'mailbox-window', ?, ?, ?, 0, ?, 1, ?, ?, ?, ?)`,
      params: [
        account.id, archive.id, filterJson, sortJson,
        'qs-ok', 2, Date.now(), Date.now(), Date.now(),
      ],
    });

    const snapshot = await h[DB_RPC.FOLDER_VIEW_CONSISTENCY]({
      accountId: account.id,
      folderId: archive.id,
    });

    expect(snapshot.queryViewExists).toBe(true);
    expect(snapshot.queryViewTotal).toBe(2);
    expect(snapshot.membershipTotal).toBe(2);
    expect(snapshot.membershipUnread).toBe(1);
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

  it('MESSAGE_BODY_READ returns stored text, html, and attachments', async () => {
    const account = await seedAccount();
    const inbox = await seedFolder(account.id);
    const { messageId } = await seedMessage(account.id, inbox.id, { remoteId: 'm-body' });
    const ts = Date.now();
    await h[DB_RPC.TRANSACTION]({
      statements: [
        {
          sql: `INSERT INTO body_values(message_id, part_id, kind, value, is_truncated, fetched_at, last_accessed_at)
                VALUES (?, 'text-1', 'text', ?, 0, ?, ?)`,
          params: [messageId, 'plain body', ts, ts],
        },
        {
          sql: `INSERT INTO body_values(message_id, part_id, kind, value, is_truncated, fetched_at, last_accessed_at)
                VALUES (?, 'html-1', 'html', ?, 0, ?, ?)`,
          params: [messageId, '<p>html body</p>', ts, ts],
        },
        {
          sql: `INSERT INTO body_parts(
                  message_id, part_id, position, blob_id, parent_part_id,
                  media_type, charset, name, disposition, cid,
                  language, location, size,
                  is_body_text, is_body_html, is_attachment, is_inline, raw_json
                ) VALUES (?, 'att-1', 0, NULL, NULL, 'application/pdf', NULL, 'doc.pdf', 'attachment', NULL, NULL, NULL, 42, 0, 0, 1, 0, '{}')`,
          params: [messageId],
        },
      ],
    });

    const body = await h[DB_RPC.MESSAGE_BODY_READ]({ messageId });
    expect(body).toMatchObject({
      text: 'plain body',
      html: '<p>html body</p>',
      isComplete: true,
      truncatedParts: [],
      attachments: [{
        part_id: 'att-1',
        blob_id: null,
        name: 'doc.pdf',
        mime_type: 'application/pdf',
        size: 42,
        disposition: 'attachment',
        cid: null,
      }],
    });
    expect(body.bodyParts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'text', value: 'plain body', isTruncated: false }),
      expect.objectContaining({ kind: 'html', value: '<p>html body</p>', isTruncated: false }),
    ]));
    expect(await h[DB_RPC.MESSAGE_BODY_READ]({ messageId: messageId + 999 })).toBeNull();
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

  it('replaces folder membership for multiple messages in one call', async () => {
    const account = await seedAccount();
    const inbox = await seedFolder(account.id, { remoteId: 'inbox', role: 'inbox' });
    const archive = await seedFolder(account.id, { remoteId: 'archive', role: 'archive' });
    const t = Date.now();
    const a = await seedMessage(account.id, inbox.id, { remoteId: 'a', receivedAt: t - 1000 });
    const b = await seedMessage(account.id, inbox.id, { remoteId: 'b', receivedAt: t });

    const result = await h[DB_RPC.FOLDER_MEMBERSHIP_REPLACE_MANY]({
      accountId: account.id,
      replacements: [
        {
          messageId: a.messageId,
          memberships: [{ folderId: archive.id, sortReceivedAt: t - 1000, sortSentAt: t - 1000 }],
        },
        {
          messageId: b.messageId,
          memberships: [{ folderId: archive.id, sortReceivedAt: t, sortSentAt: t }],
        },
      ],
    });

    expect(result).toEqual({ replaced: 2, inserted: 2 });
    expect(await h[DB_RPC.MESSAGE_LIST_FOR_FOLDER]({ folderId: inbox.id })).toHaveLength(0);
    const archived = await h[DB_RPC.MESSAGE_LIST_FOR_FOLDER]({ folderId: archive.id });
    expect(archived.map((m) => m.remote_id)).toEqual(['b', 'a']);
  });

  it('mirrors keywords to flag columns and rebuilds message_keywords on replace', async () => {
    const account = await seedAccount();
    const inbox = await seedFolder(account.id);
    const { messageId } = await seedMessage(account.id, inbox.id, { remoteId: 'm1' });

    await h[DB_RPC.MESSAGE_REPLACE_KEYWORDS]({
      messageId,
      keywords: ['$seen', '$flagged', 'work'],
      keywordsJson: JSON.stringify({ $seen: true, $flagged: true, work: true }),
    });

    const row = await engine.get('SELECT is_seen, is_flagged, is_answered, keywords_json FROM messages WHERE id = ?', [messageId]);
    expect(Number(row.is_seen)).toBe(1);
    expect(Number(row.is_flagged)).toBe(1);
    expect(Number(row.is_answered)).toBe(0);

    const kw = await engine.all('SELECT keyword FROM message_keywords WHERE message_id = ? ORDER BY keyword', [messageId]);
    expect(kw.map((k) => k.keyword)).toEqual(['$flagged', '$seen', 'work']);

    await h[DB_RPC.MESSAGE_REPLACE_KEYWORDS]({
      messageId,
      keywords: ['$seen'],
      keywordsJson: JSON.stringify({ $seen: true }),
    });
    const remaining = await engine.all('SELECT keyword FROM message_keywords WHERE message_id = ?', [messageId]);
    expect(remaining.map((k) => k.keyword)).toEqual(['$seen']);
  });

  it('batch upsert rebuilds addresses and keywords without per-row lookup state leaking', async () => {
    const account = await seedAccount();
    const inbox = await seedFolder(account.id);
    await seedMessage(account.id, inbox.id, {
      remoteId: 'batch-a',
      keywords: ['$seen', 'old'],
      addresses: [{ kind: 'from', position: 0, name: 'Old', email: 'old@example.com' }],
    });
    const before = await engine.get(
      'SELECT id, thread_id FROM messages WHERE account_id = ? AND remote_id = ?',
      [account.id, 'batch-a'],
    );

    await h[DB_RPC.MESSAGE_UPSERT_MANY]({
      accountId: account.id,
      messages: [{
        remoteId: 'batch-a',
        threadId: before.thread_id,
        remoteThreadId: 't-default',
        subject: 'updated',
        preview: 'updated preview',
        receivedAt: Date.now(),
        sentAt: Date.now(),
        hasAttachment: false,
        keywordsJson: JSON.stringify({ $flagged: true }),
        keywords: ['$flagged'],
        isSeen: false,
        isFlagged: true,
        isAnswered: false,
        isDraft: false,
        isForwarded: false,
        isJunk: false,
        fromText: 'New <new@example.com>',
        toText: 'Dest <dest@example.com>',
        addresses: [
          { kind: 'from', position: 0, name: 'New', email: 'new@example.com' },
          { kind: 'to', position: 0, name: 'Dest', email: 'dest@example.com' },
        ],
      }],
    });

    const addresses = await engine.all(
      'SELECT kind, email FROM message_addresses WHERE message_id = ? ORDER BY kind',
      [before.id],
    );
    expect(addresses).toEqual([
      { kind: 'from', email: 'new@example.com' },
      { kind: 'to', email: 'dest@example.com' },
    ]);
    const keywords = await engine.all(
      'SELECT keyword FROM message_keywords WHERE message_id = ? ORDER BY keyword',
      [before.id],
    );
    expect(keywords.map((k) => k.keyword)).toEqual(['$flagged']);
    const row = await engine.get('SELECT subject, is_seen, is_flagged FROM messages WHERE id = ?', [before.id]);
    expect(row.subject).toBe('updated');
    expect(Number(row.is_seen)).toBe(0);
    expect(Number(row.is_flagged)).toBe(1);
  });

  it('returns a message addresses in header order for the reply path', async () => {
    // Cc and Reply-To live nowhere else in the cache: there is no column
    // for either, so Reply All can only be computed from these rows.
    const account = await seedAccount();
    const inbox = await seedFolder(account.id, { remoteId: 'inbox', role: 'inbox' });
    const { messageId } = await seedMessage(account.id, inbox.id, {
      remoteId: 'with-cc',
      addresses: [
        { kind: 'from', position: 0, name: 'Alice', email: 'alice@example.com' },
        { kind: 'to', position: 1, name: null, email: 'second@example.com' },
        { kind: 'to', position: 0, name: 'First', email: 'first@example.com' },
        { kind: 'cc', position: 0, name: 'Carol', email: 'carol@example.com' },
        { kind: 'replyTo', position: 0, name: null, email: 'replies@example.com' },
      ],
    });

    const rows = await h[DB_RPC.MESSAGE_LIST_ADDRESSES]({ messageId });

    expect(rows).toEqual([
      { kind: 'cc', position: 0, name: 'Carol', email: 'carol@example.com' },
      { kind: 'from', position: 0, name: 'Alice', email: 'alice@example.com' },
      { kind: 'replyTo', position: 0, name: null, email: 'replies@example.com' },
      { kind: 'to', position: 0, name: 'First', email: 'first@example.com' },
      { kind: 'to', position: 1, name: null, email: 'second@example.com' },
    ]);
  });

  it('returns no addresses for a message that has none', async () => {
    const account = await seedAccount();
    const inbox = await seedFolder(account.id, { remoteId: 'inbox', role: 'inbox' });
    const { messageId } = await seedMessage(account.id, inbox.id, {
      remoteId: 'bare',
      addresses: [],
    });

    expect(await h[DB_RPC.MESSAGE_LIST_ADDRESSES]({ messageId })).toEqual([]);
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

  it('computes metadata progress from overlapping query_view_ranges', async () => {
    const account = await seedAccount();
    const archive = await seedFolder(account.id, {
      remoteId: 'mb-progress',
      name: 'Archive',
      role: 'archive',
      totalEmails: 500,
    });
    const filterJson = JSON.stringify({ inMailbox: archive.remote_id });
    const sortJson = JSON.stringify([{ property: 'receivedAt', isAscending: false }]);
    await h[DB_RPC.QUERY]({
      sql: `INSERT INTO query_views(
              account_id, view_type, folder_id, filter_json, sort_json,
              collapse_threads, query_state, can_calculate_changes, total,
              created_at, updated_at, last_accessed_at
            ) VALUES (?, 'mailbox-window', ?, ?, ?, 0, 'qs', 1, 500, ?, ?, ?)`,
      params: [account.id, archive.id, filterJson, sortJson, Date.now(), Date.now(), Date.now()],
    });
    const view = await engine.get(
      `SELECT id FROM query_views WHERE account_id = ? AND folder_id = ?`,
      [account.id, archive.id],
    );
    await h[DB_RPC.TRANSACTION]({
      statements: [
        [0, 100],
        [50, 150],
        [200, 260],
        [240, 300],
      ].map(([start, end]) => ({
        sql: `INSERT INTO query_view_ranges(view_id, start_position, end_position, fetched_at)
              VALUES (?, ?, ?, ?)`,
        params: [view.id, start, end, Date.now()],
      })),
    });

    const progress = await h[DB_RPC.QUERY_VIEW_PROGRESS]({
      accountId: account.id,
      folderId: archive.id,
      sort: 'received',
    });
    expect(progress).toEqual({
      total: 500,
      covered: 250,
      percent: 50,
      stale: false,
    });
  });
});

describe('queryView.applyChanges', () => {
  async function seedView(account, folder, ids) {
    const filterJson = JSON.stringify({ inMailbox: folder.remote_id });
    const sortJson = JSON.stringify([{ property: 'receivedAt', isAscending: false }]);
    const ts = Date.now();
    await h[DB_RPC.QUERY]({
      sql: `INSERT INTO query_views(
              account_id, view_type, folder_id, filter_json, sort_json,
              collapse_threads, query_state, can_calculate_changes, total,
              created_at, updated_at, last_accessed_at
            ) VALUES (?, 'mailbox-window', ?, ?, ?, 0, 'qs', 1, ?, ?, ?, ?)`,
      params: [account.id, folder.id, filterJson, sortJson, ids.length, ts, ts, ts],
    });
    const view = await engine.get(
      `SELECT id FROM query_views WHERE account_id = ? AND folder_id = ?`,
      [account.id, folder.id],
    );
    await h[DB_RPC.TRANSACTION]({
      statements: ids.map((id, i) => ({
        sql: `INSERT INTO query_view_items(view_id, position, message_id, remote_id)
              VALUES (?, ?, NULL, ?)`,
        params: [view.id, i, id],
      })),
    });
    return view.id;
  }

  async function readItems(viewId) {
    const rows = await engine.all(
      `SELECT position, remote_id FROM query_view_items
        WHERE view_id = ? ORDER BY position`,
      [viewId],
    );
    return rows.map((r) => [Number(r.position), r.remote_id]);
  }

  it('shifts existing positions up when inserting at the head', async () => {
    const account = await seedAccount();
    const folder = await seedFolder(account.id, { remoteId: 'mb-inbox', totalEmails: 3 });
    const viewId = await seedView(account, folder, ['a', 'b', 'c']);
    await h[DB_RPC.QUERY_VIEW_APPLY_CHANGES]({
      viewId,
      removed: [],
      added: [{ id: 'new-top', index: 0 }],
    });
    expect(await readItems(viewId)).toEqual([
      [0, 'new-top'],
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ]);
    expect(broadcaster.flush()).toContain(TABLE_FAMILIES.MESSAGES);
  });

  it('compacts positions of higher items when an item is removed', async () => {
    const account = await seedAccount();
    const folder = await seedFolder(account.id, { remoteId: 'mb-inbox', totalEmails: 4 });
    const viewId = await seedView(account, folder, ['a', 'b', 'c', 'd']);
    await h[DB_RPC.QUERY_VIEW_APPLY_CHANGES]({
      viewId,
      removed: ['b'],
      added: [],
    });
    expect(await readItems(viewId)).toEqual([
      [0, 'a'],
      [1, 'c'],
      [2, 'd'],
    ]);
    // Remove-only deltas must still broadcast MESSAGES so the mail
    // store re-reads the painted ranges and drops the deleted row.
    expect(broadcaster.flush()).toContain(TABLE_FAMILIES.MESSAGES);
  });

  it('handles a message moving within the view as delete-then-reinsert', async () => {
    const account = await seedAccount();
    const folder = await seedFolder(account.id, { remoteId: 'mb-inbox', totalEmails: 3 });
    const viewId = await seedView(account, folder, ['a', 'b', 'c']);
    await h[DB_RPC.QUERY_VIEW_APPLY_CHANGES]({
      viewId,
      removed: [],
      added: [{ id: 'c', index: 0 }],
    });
    expect(await readItems(viewId)).toEqual([
      [0, 'c'],
      [1, 'a'],
      [2, 'b'],
    ]);
  });

  it('applies multiple removals and additions in one transaction', async () => {
    const account = await seedAccount();
    const folder = await seedFolder(account.id, { remoteId: 'mb-inbox', totalEmails: 5 });
    const viewId = await seedView(account, folder, ['a', 'b', 'c', 'd', 'e']);
    await h[DB_RPC.QUERY_VIEW_APPLY_CHANGES]({
      viewId,
      removed: ['b', 'd'],
      added: [
        { id: 'x', index: 0 },
        { id: 'y', index: 2 },
      ],
    });
    // After removes (b at 1 and d at 3 deleted, surviving items
    // compacted to [a, c, e] at positions 0..2), adding x at 0 then
    // y at 2 yields [x, a, y, c, e].
    expect(await readItems(viewId)).toEqual([
      [0, 'x'],
      [1, 'a'],
      [2, 'y'],
      [3, 'c'],
      [4, 'e'],
    ]);
  });

  it('is a no-op when both arrays are empty', async () => {
    const account = await seedAccount();
    const folder = await seedFolder(account.id, { remoteId: 'mb-inbox', totalEmails: 1 });
    const viewId = await seedView(account, folder, ['a']);
    broadcaster.flush();
    const result = await h[DB_RPC.QUERY_VIEW_APPLY_CHANGES]({
      viewId, removed: [], added: [],
    });
    expect(result).toEqual({ removed: 0, added: 0 });
    expect(broadcaster.flush()).not.toContain(TABLE_FAMILIES.MESSAGES);
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
          addressbookIds: [ab.id],
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
      `SELECT account_id, email_key
         FROM contact_emails
        WHERE contact_id = (SELECT id FROM contacts WHERE remote_id = ?)
        ORDER BY position`,
      ['c-1'],
    );
    expect(rows).toEqual([
      { account_id: account.id, email_key: 'jane@example.com' },
      { account_id: account.id, email_key: 'jane.doe@work.example.com' },
    ]);

    await h[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts: [
        {
          addressbookIds: [ab.id],
          remoteId: 'c-1',
          fullName: 'Jane Doe',
          displayName: 'Jane Doe',
          emails: [{ email: 'jane@new.example.com' }],
        },
      ],
    });
    rows = await engine.all(
      `SELECT account_id, email_key
         FROM contact_emails
        WHERE contact_id = (SELECT id FROM contacts WHERE remote_id = ?)`,
      ['c-1'],
    );
    expect(rows).toEqual([
      { account_id: account.id, email_key: 'jane@new.example.com' },
    ]);
  });

  it('files one card in every book it belongs to', async () => {
    // RFC 9610 lets a card belong to several books, and which books it is
    // in is something a user arranged. The old shape kept the first and
    // dropped the rest.
    const account = await seedAccount();
    await h[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [
        { remoteId: 'ab-personal', name: 'Personal', isDefault: true },
        { remoteId: 'ab-work', name: 'Work' },
      ],
    });
    const books = await engine.all(
      'SELECT id, remote_id FROM addressbooks WHERE account_id = ? ORDER BY remote_id',
      [account.id],
    );
    const [personal, work] = books.map((book) => book.id);

    await h[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts: [{
        addressbookIds: [personal, work],
        remoteId: 'c-1',
        displayName: 'Ada',
        emails: [{ email: 'ada@example.com' }],
      }],
    });

    const rows = await engine.all('SELECT id FROM contacts WHERE account_id = ?', [account.id]);
    expect(rows, 'one card is one contact').toHaveLength(1);
    const listed = await h[DB_RPC.CONTACT_LIST]({ accountId: account.id });
    expect(listed[0].addressbook_ids.sort()).toEqual([personal, work].sort());
    const fetched = await h[DB_RPC.CONTACT_GET]({
      accountId: account.id,
      contactId: rows[0].id,
    });
    expect(fetched.addressbook_ids.sort()).toEqual([personal, work].sort());
  });

  it('lists the whole address book when no limit is asked for', async () => {
    // The compose browse path calls CONTACT_LIST with no limit and relies
    // on getting every card back (CS-3.12); a default page size here would
    // silently hide the contacts sorted after it.
    const account = await seedAccount();
    await h[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', name: 'Default', isDefault: true }],
    });
    const books = await engine.all(
      'SELECT id FROM addressbooks WHERE account_id = ?', [account.id],
    );

    await h[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts: Array.from({ length: 250 }, (_, i) => ({
        addressbookIds: [books[0].id],
        remoteId: `c-${i}`,
        displayName: `Contact ${String(i).padStart(3, '0')}`,
        emails: [{ email: `contact${i}@example.com` }],
      })),
    });

    const listed = await h[DB_RPC.CONTACT_LIST]({ accountId: account.id });
    expect(listed).toHaveLength(250);
  });

  it('takes a contact out of a book it has been removed from', async () => {
    const account = await seedAccount();
    await h[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [
        { remoteId: 'ab-personal', name: 'Personal', isDefault: true },
        { remoteId: 'ab-work', name: 'Work' },
      ],
    });
    const books = await engine.all(
      'SELECT id FROM addressbooks WHERE account_id = ? ORDER BY remote_id',
      [account.id],
    );
    const [personal, work] = books.map((book) => book.id);
    const card = {
      remoteId: 'c-1',
      displayName: 'Ada',
      emails: [{ email: 'ada@example.com' }],
    };

    await h[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts: [{ ...card, addressbookIds: [personal, work] }],
    });
    await h[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts: [{ ...card, addressbookIds: [personal] }],
    });

    const listed = await h[DB_RPC.CONTACT_LIST]({ accountId: account.id });
    expect(listed[0].addressbook_ids).toEqual([personal]);
  });

  it('sweeps the contacts a completed sync did not see, and only those', async () => {
    const account = await seedAccount();
    await h[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', name: 'Default', isDefault: true }],
    });
    const ab = await engine.get('SELECT id FROM addressbooks WHERE remote_id = ?', ['ab-default']);
    const contact = (remoteId: string) => ({
      addressbookIds: [ab.id],
      remoteId,
      displayName: remoteId,
      emails: [{ email: `${remoteId}@example.com` }],
    });

    await h[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts: [contact('stays'), contact('goes')],
      generation: 100,
    });
    // The next sync sees only one of them, as it would if the other card
    // had been deleted on the server.
    await h[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts: [contact('stays')],
      generation: 200,
    });

    const { swept } = await h[DB_RPC.CONTACT_SWEEP_STALE]({
      accountId: account.id,
      generation: 200,
    });

    expect(swept).toBe(1);
    const live = await h[DB_RPC.CONTACT_LIST]({ accountId: account.id });
    expect(live.map((row: any) => row.remote_id)).toEqual(['stays']);
  });

  it('refuses to sweep without the generation the sync stamped', async () => {
    // A sweep with no generation, or a zero one, would match every row: the
    // failure mode is deleting the address book, so it must not be reachable
    // by a caller that forgot an argument.
    const account = await seedAccount();

    await expect(h[DB_RPC.CONTACT_SWEEP_STALE]({ accountId: account.id }))
      .rejects.toThrow(/generation/);
    await expect(h[DB_RPC.CONTACT_SWEEP_STALE]({ accountId: account.id, generation: 0 }))
      .rejects.toThrow(/generation/);
  });

  it('does not let a targeted reconcile backdate a row into a sweep', async () => {
    // A reconcile after a single-card edit passes no generation. If that
    // reset the stamp, the card the user just saved would be swept by a
    // full sync that had already passed it.
    const account = await seedAccount();
    await h[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', name: 'Default', isDefault: true }],
    });
    const ab = await engine.get('SELECT id FROM addressbooks WHERE remote_id = ?', ['ab-default']);
    const card = {
      addressbookIds: [ab.id],
      remoteId: 'c-1',
      displayName: 'Ada',
      emails: [{ email: 'ada@example.com' }],
    };

    await h[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts: [card],
      generation: 300,
    });
    await h[DB_RPC.CONTACT_UPSERT_MANY]({ accountId: account.id, contacts: [card] });

    const row = await engine.get('SELECT sync_generation FROM contacts WHERE remote_id = ?', ['c-1']);
    expect(row.sync_generation).toBe(300);
  });

  it('autocompletes only from contacts, never from received mail', async () => {
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
          addressbookIds: [ab.id],
          remoteId: 'c-jane',
          displayName: 'Jane Doe',
          emails: [{ email: 'Jane@Example.com', isPreferred: true }],
        },
        {
          addressbookIds: [ab.id],
          remoteId: 'c-jay',
          displayName: 'Jay',
          emails: [{ email: 'jay@example.com' }],
        },
        {
          addressbookIds: [ab.id],
          remoteId: 'c-jasmine',
          displayName: 'Jasmine',
          emails: [{ email: 'jasmine@contacts.example' }],
        },
      ],
    });

    // Someone who wrote to the user and was never written back to. This is
    // the address the old implementation would offer and CS-3.3 forbids:
    // being mailed by a stranger is not evidence you want to mail them.
    await seedFolder(account.id);
    await h[DB_RPC.MESSAGE_UPSERT_MANY]({
      accountId: account.id,
      messages: [{
        remoteId: 'm-from-stranger',
        threadId: null,
        rfc822MessageId: '<x@example.com>',
        subject: 'unsolicited',
        receivedAt: Date.now(),
        keywordsJson: '{}',
        keywords: [],
        addresses: [
          { kind: 'from', position: 0, name: 'Jarvis', email: 'jarvis@stranger.example' },
        ],
        metadataFetchedAt: Date.now(),
      }],
    });

    const matches = await h[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: account.id,
      prefix: 'ja',
      limit: 10,
    });
    const emails = matches.map((m) => m.email);
    expect(emails).toContain('Jane@Example.com');
    expect(emails).toContain('jasmine@contacts.example');
    expect(emails).not.toContain('jarvis@stranger.example');
    expect(new Set(matches.map((m) => m.source))).toEqual(new Set(['contact']));
  });

  it('finds a contact by a word of its name, not just by address (CS-3.1, CS-3.2)', async () => {
    const account = await seedAccount();
    await h[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', isDefault: true, name: 'Default' }],
    });
    const ab = await engine.get('SELECT id FROM addressbooks WHERE remote_id = ?', ['ab-default']);
    await h[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts: [{
        addressbookIds: [ab.id],
        remoteId: 'c-jane',
        displayName: 'Smith, Jane',
        givenName: 'Jane',
        familyName: 'Smith',
        // Nothing about this address begins with "jane", which is why an
        // address-prefix-only implementation could never find her.
        emails: [{ email: 'jqs@example.com', isPreferred: true }],
      }],
    });

    const byGivenName = await h[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: account.id, prefix: 'jane', limit: 10,
    });
    expect(byGivenName.map((m) => m.email)).toEqual(['jqs@example.com']);

    // Two words, in the order the name is not stored in.
    const unordered = await h[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: account.id, prefix: 'jane smi', limit: 10,
    });
    expect(unordered.map((m) => m.email)).toEqual(['jqs@example.com']);

    // A second word narrows rather than widens: nobody is called "jane
    // nokia", so nothing matches.
    const narrowed = await h[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: account.id, prefix: 'jane nokia', limit: 10,
    });
    expect(narrowed).toEqual([]);
  });

  it('stops matching a name the contact no longer has', async () => {
    const account = await seedAccount();
    await h[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', isDefault: true, name: 'Default' }],
    });
    const ab = await engine.get('SELECT id FROM addressbooks WHERE remote_id = ?', ['ab-default']);
    const card = {
      addressbookIds: [ab.id],
      remoteId: 'c-1',
      displayName: 'Jane Maidenname',
      emails: [{ email: 'jane@example.com' }],
    };
    await h[DB_RPC.CONTACT_UPSERT_MANY]({ accountId: account.id, contacts: [card] });
    await h[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts: [{ ...card, displayName: 'Jane Marriedname' }],
    });

    const byNewName = await h[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: account.id, prefix: 'marriedname', limit: 10,
    });
    expect(byNewName.map((m) => m.email)).toEqual(['jane@example.com']);
    // Tokens are replaced rather than added to, so the old name stops
    // matching. Otherwise a rename would leave a suggestion nobody could
    // account for.
    const byOldName = await h[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: account.id, prefix: 'maidenname', limit: 10,
    });
    expect(byOldName).toEqual([]);
  });

  // The two tests below were written to characterise the defects the
  // autocomplete rewrite (CS-3.4, CS-3.6) is specified to remove. They now
  // assert the fixed behaviour: the old expectations are recorded in each
  // one so the change of contract stays legible.

  it('offers one row per address however many names it was stored under (CS-3.4)', async () => {
    const account = await seedAccount();
    await h[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', isDefault: true, name: 'Default' }],
    });
    const ab = await engine.get('SELECT id FROM addressbooks WHERE remote_id = ?', ['ab-default']);
    // One correspondent known through two duplicate cards.
    await h[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts: [
        {
          addressbookIds: [ab.id],
          remoteId: 'c-dana-work',
          displayName: 'Dana Smith',
          emails: [{ email: 'dana@example.com', isPreferred: true }],
        },
        {
          addressbookIds: [ab.id],
          remoteId: 'c-dana-old',
          displayName: 'dana',
          emails: [{ email: 'Dana@Example.com' }],
        },
      ],
    });
    const matches = await h[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: account.id,
      prefix: 'dana',
      limit: 10,
    });
    // Previously: two rows, one per stored display name — issue #58. The
    // addresses differ only by case, which CS-3.5 folds for comparison.
    expect(matches.map((m) => m.email)).toEqual(['dana@example.com']);
    // The preferred card's metadata wins deterministically.
    expect(matches[0].name).toBe('Dana Smith');
    expect(matches[0].source).toBe('contact');

    // Deterministic means the same answer twice, not merely one answer.
    const again = await h[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: account.id,
      prefix: 'dana',
      limit: 10,
    });
    expect(again).toEqual(matches);
  });

  it('offers the exact address typed even when contacts could fill the limit (CS-3.6)', async () => {
    const account = await seedAccount();
    await h[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', isDefault: true, name: 'Default' }],
    });
    const ab = await engine.get('SELECT id FROM addressbooks WHERE remote_id = ?', ['ab-default']);
    const contacts = [];
    for (let i = 0; i < 8; i += 1) {
      contacts.push({
        addressbookIds: [ab.id],
        remoteId: `c-team-${i}`,
        displayName: `Team ${i}`,
        emails: [{ email: `team-${i}@example.com` }],
      });
    }
    contacts.push({
      addressbookIds: [ab.id],
      remoteId: 'c-team-exact',
      displayName: 'Team Exact',
      emails: [{ email: 'team@example.com' }],
    });
    await h[DB_RPC.CONTACT_UPSERT_MANY]({ accountId: account.id, contacts });

    // There are enough contacts sharing the prefix to fill the limit.
    const matches = await h[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: account.id,
      prefix: 'team@example.com',
      limit: 8,
    });
    expect(matches[0].email).toBe('team@example.com');

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

  it('does not throw FOREIGN KEY constraint when target_message_id references a deleted row', async () => {
    // Reproduces the bug a user can hit by double-clicking Delete on
    // a ghost message: the first click destroyed the local messages
    // row (via reconcile-then-applyDestroyLocally), so the second
    // click feeds a stale id into pending_mutations.target_message_id
    // and SQLite's FK enforcement aborts the INSERT. The handler now
    // verifies the id exists and nulls it out instead.
    const account = await seedAccount();
    const stale = await h[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: 'destroy',
      targetMessageId: 99999, // does not exist
      requestJson: JSON.stringify({}),
    });
    expect(stale.id).toBeGreaterThan(0);
    const row = await engine.get(
      'SELECT target_message_id, mutation_type FROM pending_mutations WHERE id = ?',
      [stale.id],
    );
    expect(row.target_message_id).toBeNull();
    expect(row.mutation_type).toBe('destroy');
  });
});

describe('queryView.resetForFolder', () => {
  it('deletes the mailbox-window view and cascades to items / ranges', async () => {
    const account = await seedAccount();
    const inbox = await seedFolder(account.id, { remoteId: 'mb-inbox', role: 'inbox' });
    const filterJson = JSON.stringify({ inMailbox: 'mb-inbox' });
    const sortJson = JSON.stringify([{ property: 'receivedAt', isAscending: false }]);
    const ts = Date.now();
    await h[DB_RPC.QUERY]({
      sql: `INSERT INTO query_views(
              account_id, view_type, folder_id, filter_json, sort_json,
              collapse_threads, query_state, can_calculate_changes, total,
              created_at, updated_at, last_accessed_at
            ) VALUES (?, 'mailbox-window', ?, ?, ?, 0, 'qs', 1, 3, ?, ?, ?)`,
      params: [account.id, inbox.id, filterJson, sortJson, ts, ts, ts],
    });
    const view = await engine.get(
      `SELECT id FROM query_views WHERE folder_id = ?`,
      [inbox.id],
    );
    await h[DB_RPC.TRANSACTION]({
      statements: [
        { sql: `INSERT INTO query_view_items(view_id, position, message_id, remote_id) VALUES (?, 0, NULL, 'e-1')`, params: [view.id] },
        { sql: `INSERT INTO query_view_items(view_id, position, message_id, remote_id) VALUES (?, 1, NULL, 'e-2')`, params: [view.id] },
        { sql: `INSERT INTO query_view_ranges(view_id, start_position, end_position, fetched_at) VALUES (?, 0, 2, ?)`, params: [view.id, ts] },
      ],
    });

    const result = await h[DB_RPC.QUERY_VIEW_RESET_FOR_FOLDER]({
      accountId: account.id,
      folderId: inbox.id,
    });
    expect(result.deleted).toBe(1);

    expect(await engine.all(`SELECT id FROM query_views WHERE folder_id = ?`, [inbox.id])).toEqual([]);
    expect(await engine.all(`SELECT view_id FROM query_view_items WHERE view_id = ?`, [view.id])).toEqual([]);
    expect(await engine.all(`SELECT view_id FROM query_view_ranges WHERE view_id = ?`, [view.id])).toEqual([]);
    expect(broadcaster.flush()).toContain(TABLE_FAMILIES.MESSAGES);
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

  it('serves the autocomplete prefix scan by index, on the query production runs', async () => {
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
        addressbookIds: [ab.id],
        remoteId: `c-${i}`,
        displayName: `Person ${i}`,
        emails: [{ email: `person${i}@example.com` }],
      });
    }
    await h[DB_RPC.CONTACT_UPSERT_MANY]({ accountId: account.id, contacts: seed });
    await engine.exec('ANALYZE');

    // EXPLAIN the exported SQL the handler actually issues, not a copy that
    // can drift from it. The half-open range over email_key must be what an
    // index answers: no full SCAN of either table.
    const plan = await engine.all(
      `EXPLAIN QUERY PLAN ${CONTACT_ADDRESS_PREFIX_SQL}`,
      [account.id, 'pers', 'pert', 40],
    );
    const detail = plan.map((row) => row.detail).join(' | ');
    expect(detail).not.toMatch(/SCAN contact_emails\b(?! USING)/i);
    expect(detail).not.toMatch(/SCAN contacts\b(?! USING)/i);
    expect(detail).toMatch(/contact_emails_key_lookup/);
  });

});
