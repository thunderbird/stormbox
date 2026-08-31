import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  CONTACTS_TRASH_LEGACY_FILE_NAME,
  CONTACTS_TRASH_MAX_DOCUMENT_BYTES,
  CONTACTS_TRASH_MAX_SHARD_ENTRIES,
  CONTACTS_TRASH_MAX_TOMBSTONE_SHARD_BYTES,
  CONTACTS_TRASH_RETENTION_MS,
  emptyContactsTrashDocument,
  emptyContactsTrashShardDocument,
  type ContactTrashDocumentEntry,
} from '../../../src/constants/contacts-trash-document';
import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';

let engine: any;
let handlers: Record<string, (params: any) => Promise<any>>;
let accountId: number;

function remoteShard(doc: unknown, remoteNodeId = 'trash-node') {
  return [{
    shardName: CONTACTS_TRASH_LEGACY_FILE_NAME,
    doc,
    remoteNodeId,
    legacy: true,
  }];
}

function entry(overrides: Partial<ContactTrashDocumentEntry> = {}): ContactTrashDocumentEntry {
  return {
    uid: 'uid-1',
    remoteId: 'card-1',
    addressBookIds: ['book-1'],
    trashedAt: 1_000,
    expiresAt: 1_000 + CONTACTS_TRASH_RETENTION_MS,
    status: 'trashed',
    updatedAt: 1_000,
    emailKeys: ['person@example.com'],
    displayName: 'Person',
    primaryEmail: 'Person@example.com',
    media: [],
    snapshot: {
      id: 'card-1',
      uid: 'uid-1',
      addressBookIds: { 'book-1': true },
      customUnknown: { preserved: true },
    },
    ...overrides,
  };
}

beforeEach(async () => {
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
  const account = await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'Trash User',
    primaryEmail: 'trash@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: 'trash-account',
    isPrimary: true,
  });
  accountId = account.row.id;
});

afterEach(async () => {
  await engine.close();
});

describe('contacts trash handlers', () => {
  it('creates random shards lazily and caps each shard at 128 records', async () => {
    expect(await engine.get(
      'SELECT COUNT(*) AS count FROM contacts_trash_documents WHERE account_id = ?',
      [accountId],
    )).toEqual({ count: 0 });
    await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId,
      entries: Array.from({ length: 129 }, (_, index) => entry({
        uid: `uid-${index}`,
        remoteId: `card-${index}`,
        snapshot: {
          id: `card-${index}`,
          uid: `uid-${index}`,
          addressBookIds: { 'book-1': true },
        },
      })),
    });

    const rows = await engine.all(
      `SELECT shard_name, doc_json
         FROM contacts_trash_documents
        WHERE account_id = ?
        ORDER BY shard_name`,
      [accountId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row: any) =>
      /^stormbox-contacts-trash-[0-9a-f-]{36}\.json$/i.test(row.shard_name)))
      .toBe(true);
    const counts = rows.map((row: any) =>
      Object.keys(JSON.parse(row.doc_json).entries).length).sort((a: number, b: number) => a - b);
    expect(counts).toEqual([1, CONTACTS_TRASH_MAX_SHARD_ENTRIES]);
    expect(rows.every((row: any) =>
      new TextEncoder().encode(row.doc_json).byteLength <= CONTACTS_TRASH_MAX_DOCUMENT_BYTES))
      .toBe(true);
  });

  it('merges lifecycle records across independent remote shards', async () => {
    const active = emptyContactsTrashShardDocument();
    active.entries.active = entry({ updatedAt: 1_000 });
    const terminal = emptyContactsTrashShardDocument();
    terminal.entries.terminal = entry({
      status: 'purged',
      snapshot: null,
      updatedAt: 2_000,
    });

    const result = await handlers[DB_RPC.CONTACT_TRASH_MERGE_REMOTE_SHARDS]({
      accountId,
      shards: [
        {
          shardName: 'stormbox-contacts-trash-00000000-0000-4000-8000-000000000001.json',
          doc: active,
          remoteNodeId: 'node-active',
        },
        {
          shardName: 'stormbox-contacts-trash-00000000-0000-4000-8000-000000000002.json',
          doc: terminal,
          remoteNodeId: 'node-terminal',
        },
      ],
      ensurePush: false,
    });

    expect(result.doc.entries['uid-1']).toMatchObject({
      status: 'purged',
      snapshot: null,
    });
    expect(await handlers[DB_RPC.CONTACT_TRASH_LIST]({ accountId })).toEqual([]);
  });

  it('keeps the legacy document immutable and appends lifecycle writes to a shard', async () => {
    const legacy = emptyContactsTrashDocument();
    legacy.entries['uid-1'] = entry({
      expiresAt: Date.now() + CONTACTS_TRASH_RETENTION_MS,
      updatedAt: Date.now(),
    });
    await handlers[DB_RPC.CONTACT_TRASH_MERGE_REMOTE_SHARDS]({
      accountId,
      shards: remoteShard(legacy),
      ensurePush: false,
    });
    const before = await engine.get(
      `SELECT doc_json
         FROM contacts_trash_documents
        WHERE account_id = ? AND shard_name = ?`,
      [accountId, CONTACTS_TRASH_LEGACY_FILE_NAME],
    );
    const [row] = await handlers[DB_RPC.CONTACT_TRASH_LIST]({ accountId });

    const changed = await handlers[DB_RPC.CONTACT_TRASH_SET_STATUS]({
      accountId,
      trashIds: [row.id],
      status: 'restored',
    });

    expect(changed.touchedShards).toHaveLength(1);
    expect(changed.touchedShards[0]).not.toBe(CONTACTS_TRASH_LEGACY_FILE_NAME);
    expect(await engine.get(
      `SELECT doc_json
         FROM contacts_trash_documents
        WHERE account_id = ? AND shard_name = ?`,
      [accountId, CONTACTS_TRASH_LEGACY_FILE_NAME],
    )).toEqual(before);
  });

  it('keeps a non-full snapshot shard clean while purge uses a small tombstone shard', async () => {
    await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId,
      entries: [entry()],
    });
    const [firstTrash] = await handlers[DB_RPC.CONTACT_TRASH_LIST]({ accountId });
    const [fullShard] = await engine.all(
      `SELECT shard_name, doc_json, local_revision
         FROM contacts_trash_documents
        WHERE account_id = ?`,
      [accountId],
    );
    await handlers[DB_RPC.CONTACT_TRASH_CONFIRM_SHARD]({
      accountId,
      shardName: fullShard.shard_name,
      remoteNodeId: 'full-node',
      localRevision: fullShard.local_revision,
    });

    const changed = await handlers[DB_RPC.CONTACT_TRASH_SET_STATUS]({
      accountId,
      trashIds: [firstTrash.id],
      status: 'purged',
    });

    expect(changed.touchedShards).toHaveLength(1);
    expect(changed.touchedShards[0]).not.toBe(fullShard.shard_name);
    expect((await engine.get(
      `SELECT doc_json, dirty
         FROM contacts_trash_documents
        WHERE account_id = ? AND shard_name = ?`,
      [accountId, fullShard.shard_name],
    ))).toEqual({ doc_json: fullShard.doc_json, dirty: 0 });
    const small = await engine.get(
      `SELECT doc_json, dirty
         FROM contacts_trash_documents
        WHERE account_id = ? AND shard_name = ?`,
      [accountId, changed.touchedShards[0]],
    );
    expect(Object.keys(JSON.parse(small.doc_json).entries)).toHaveLength(1);
    expect(small.dirty).toBe(1);
    expect(new TextEncoder().encode(small.doc_json).byteLength)
      .toBeLessThanOrEqual(CONTACTS_TRASH_MAX_TOMBSTONE_SHARD_BYTES);
  });

  it('marks a shard clean only when the uploaded revision is still current', async () => {
    await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId,
      entries: [entry()],
    });
    const [uploading] = await handlers[DB_RPC.CONTACT_TRASH_GET_SHARDS]({
      accountId,
      dirtyOnly: true,
    });
    await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId,
      entries: [entry({
        uid: 'uid-2',
        remoteId: 'card-2',
        snapshot: {
          id: 'card-2',
          uid: 'uid-2',
          addressBookIds: { 'book-1': true },
        },
      })],
    });

    await expect(handlers[DB_RPC.CONTACT_TRASH_CONFIRM_SHARD]({
      accountId,
      shardName: uploading.shardName,
      remoteNodeId: 'node-1',
      remoteBlobId: 'blob-old',
      localRevision: uploading.localRevision,
    })).resolves.toEqual({ clean: false });
    const [current] = await handlers[DB_RPC.CONTACT_TRASH_GET_SHARDS]({
      accountId,
      shardNames: [uploading.shardName],
    });
    expect(current).toMatchObject({
      dirty: true,
      remoteNodeId: 'node-1',
      remoteBlobId: 'blob-old',
    });
    await expect(handlers[DB_RPC.CONTACT_TRASH_CONFIRM_SHARD]({
      accountId,
      shardName: current.shardName,
      remoteNodeId: 'node-1',
      remoteBlobId: 'blob-current',
      localRevision: current.localRevision,
    })).resolves.toEqual({ clean: true });
  });

  it('returns the dirty source shard when restaging an identical snapshot', async () => {
    const first = await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId,
      entries: [entry()],
    });
    const restaged = await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId,
      entries: [entry()],
    });

    expect(first.touchedShards).toHaveLength(1);
    expect(restaged.touchedShards).toEqual(first.touchedShards);
  });

  it('returns every dirty matching shard for a one-target replay', async () => {
    await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId,
      entries: [entry()],
    });
    const [source] = await engine.all(
      `SELECT doc_json
         FROM contacts_trash_documents
        WHERE account_id = ?`,
      [accountId],
    );
    const duplicateName = 'stormbox-contacts-trash-00000000-0000-4000-8000-000000000099.json';
    await engine.run(
      `INSERT INTO contacts_trash_documents(
         account_id, shard_name, doc_json, dirty, local_revision, updated_at
       ) VALUES (?, ?, ?, 1, 1, ?)`,
      [accountId, duplicateName, source.doc_json, Date.now()],
    );

    const replay = await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId,
      entries: [entry()],
      singleShard: true,
    });

    expect(replay.touchedShards).toHaveLength(2);
    expect(replay.touchedShards).toContain(duplicateName);
  });

  it('refuses to shadow an active UID owned by another remote card', async () => {
    await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId,
      entries: [entry()],
    });

    await expect(handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId,
      entries: [entry({
        remoteId: 'card-conflict',
        snapshot: {
          id: 'card-conflict',
          uid: 'uid-1',
          addressBookIds: { 'book-1': true },
        },
      })],
    })).rejects.toMatchObject({ type: 'ambiguousUid' });
    expect((await handlers[DB_RPC.CONTACT_TRASH_GET_DOCUMENT]({
      accountId,
    })).doc.entries['uid-1'].remoteId).toBe('card-1');
  });

  it('projects complete snapshots and canonical email keys without list-time parsing', async () => {
    await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId,
      entries: [entry()],
    });

    const list = await handlers[DB_RPC.CONTACT_TRASH_LIST]({ accountId });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      uid: 'uid-1',
      prior_remote_id: 'card-1',
      display_name: 'Person',
    });
    const detail = await handlers[DB_RPC.CONTACT_TRASH_GET]({
      accountId,
      trashId: list[0].id,
    });
    expect(detail.snapshot.customUnknown).toEqual({ preserved: true });
    expect(detail.original_addressbook_ids).toEqual(['book-1']);
    expect(detail.email_keys).toEqual(['person@example.com']);
    expect(await engine.get(
      `SELECT email_key FROM contacts_trash_emails
        WHERE account_id = ? AND trash_id = ?`,
      [accountId, list[0].id],
    )).toEqual({ email_key: 'person@example.com' });
  });

  it('purges expired remote entries and queues one document repair atomically', async () => {
    const remote = emptyContactsTrashDocument();
    remote.entries['uid-1'] = entry({ expiresAt: Date.now() - 1 });
    const result = await handlers[DB_RPC.CONTACT_TRASH_MERGE_REMOTE_SHARDS]({
      accountId,
      shards: remoteShard(remote),
    });

    expect(result.doc.entries['uid-1']).toMatchObject({
      status: 'purged',
      snapshot: null,
    });
    expect(await handlers[DB_RPC.CONTACT_TRASH_LIST]({ accountId })).toEqual([]);
    expect(await engine.get(
      `SELECT COUNT(*) AS count FROM pending_mutations
        WHERE account_id = ? AND mutation_type = 'pushContactsTrash'`,
      [accountId],
    )).toEqual({ count: 1 });
  });

  it('rolls back projection changes when repair enqueue fails', async () => {
    await engine.exec(`
      CREATE TRIGGER reject_trash_push
      BEFORE INSERT ON pending_mutations
      WHEN NEW.mutation_type = 'pushContactsTrash'
      BEGIN
        SELECT RAISE(ABORT, 'reject contacts trash push');
      END;
    `);
    const remote = emptyContactsTrashDocument();
    remote.entries['uid-1'] = entry({ expiresAt: Date.now() - 1 });

    await expect(handlers[DB_RPC.CONTACT_TRASH_MERGE_REMOTE_SHARDS]({
      accountId,
      shards: remoteShard(remote),
    })).rejects.toThrow(/reject contacts trash push/);
    expect(await engine.get(
      'SELECT COUNT(*) AS count FROM contacts_trash WHERE account_id = ?',
      [accountId],
    )).toEqual({ count: 0 });
  });

  it('does not rewrite unchanged projection or email rows', async () => {
    const timestamp = Date.now();
    await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId,
      entries: [entry({
        trashedAt: timestamp,
        expiresAt: timestamp + CONTACTS_TRASH_RETENTION_MS,
        updatedAt: timestamp,
      })],
    });
    await engine.exec(`
      CREATE TABLE trash_projection_writes(kind TEXT NOT NULL);
      CREATE TRIGGER count_trash_update AFTER UPDATE ON contacts_trash
      BEGIN
        INSERT INTO trash_projection_writes(kind) VALUES ('entry');
      END;
      CREATE TRIGGER count_trash_email_insert AFTER INSERT ON contacts_trash_emails
      BEGIN
        INSERT INTO trash_projection_writes(kind) VALUES ('email');
      END;
      CREATE TRIGGER count_trash_email_delete AFTER DELETE ON contacts_trash_emails
      BEGIN
        INSERT INTO trash_projection_writes(kind) VALUES ('email');
      END;
    `);
    const local = await handlers[DB_RPC.CONTACT_TRASH_GET_DOCUMENT]({ accountId });

    await handlers[DB_RPC.CONTACT_TRASH_MERGE_REMOTE_SHARDS]({
      accountId,
      shards: remoteShard(local.doc),
      ensurePush: false,
    });

    expect(await engine.get(
      'SELECT COUNT(*) AS count FROM trash_projection_writes',
    )).toEqual({ count: 0 });
  });

  it('checks unchanged projections without selecting snapshot or media JSON', async () => {
    await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId,
      entries: [entry()],
    });
    const selects: string[] = [];
    const originalAll = engine._allRaw.bind(engine);
    vi.spyOn(engine, '_allRaw').mockImplementation(async (sql: string, params: any[]) => {
      selects.push(sql);
      return originalAll(sql, params);
    });
    const local = await handlers[DB_RPC.CONTACT_TRASH_GET_DOCUMENT]({ accountId });

    await handlers[DB_RPC.CONTACT_TRASH_MERGE_REMOTE_SHARDS]({
      accountId,
      shards: remoteShard(local.doc),
      ensurePush: false,
    });

    const projectionRead = selects.find((sql) =>
      sql.includes('projection_fingerprint') && sql.includes('FROM contacts_trash'));
    expect(projectionRead).toBeDefined();
    expect(projectionRead).not.toContain('snapshot_json');
    expect(projectionRead).not.toContain('media_json');
  });

  it('bumps lifecycle time when only compact projection metadata changes', async () => {
    await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId,
      entries: [entry()],
    });

    await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId,
      entries: [entry({
        emailKeys: ['person@example.com', 'second@example.com'],
        updatedAt: 1_000,
      })],
    });

    const document = await handlers[DB_RPC.CONTACT_TRASH_GET_DOCUMENT]({ accountId });
    expect(document.doc.entries['uid-1'].updatedAt).toBeGreaterThan(1_000);
    const [row] = await handlers[DB_RPC.CONTACT_TRASH_LIST]({ accountId });
    const detail = await handlers[DB_RPC.CONTACT_TRASH_GET]({
      accountId,
      trashId: row.id,
    });
    expect(detail.email_keys).toEqual([
      'person@example.com',
      'second@example.com',
    ]);
  });

  it('queries get-many rows and emails in bounded requested-id chunks', async () => {
    await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId,
      entries: [entry()],
    });
    const [row] = await handlers[DB_RPC.CONTACT_TRASH_LIST]({ accountId });
    const selects: Array<{ sql: string; params: any[] }> = [];
    const originalAll = engine._allRaw.bind(engine);
    vi.spyOn(engine, '_allRaw').mockImplementation(async (sql: string, params: any[]) => {
      selects.push({ sql, params });
      return originalAll(sql, params);
    });
    const requested = [
      row.id,
      ...Array.from({ length: 1_100 }, (_, index) => row.id + index + 1),
    ];

    const result = await handlers[DB_RPC.CONTACT_TRASH_GET_MANY]({
      accountId,
      trashIds: requested,
    });

    expect(result[0]).toMatchObject({
      trashId: row.id,
      status: 'active',
      detail: { email_keys: ['person@example.com'] },
    });
    expect(result.slice(1).every((lookup: any) => lookup.status === 'missing')).toBe(true);
    const trashReads = selects.filter(({ sql }) =>
      /FROM contacts_trash\s+WHERE/u.test(sql) && sql.includes('id IN'));
    const emailReads = selects.filter(({ sql }) =>
      sql.includes('FROM contacts_trash_emails') && sql.includes('trash_id IN'));
    expect(trashReads.length).toBeGreaterThan(1);
    expect(emailReads.length).toBe(trashReads.length);
    expect([...trashReads, ...emailReads].every(({ params }) => params.length <= 251))
      .toBe(true);
  });

  it('throws for corrupt detail JSON and reports it distinctly in get-many', async () => {
    await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId,
      entries: [entry()],
    });
    const [row] = await handlers[DB_RPC.CONTACT_TRASH_LIST]({ accountId });
    await engine.run(
      'UPDATE contacts_trash SET snapshot_json = ? WHERE id = ?',
      ['{not-json', row.id],
    );

    await expect(handlers[DB_RPC.CONTACT_TRASH_GET]({
      accountId,
      trashId: row.id,
    })).rejects.toMatchObject({ type: 'invalidTrashSnapshot' });
    await expect(handlers[DB_RPC.CONTACT_TRASH_GET_MANY]({
      accountId,
      trashIds: [row.id, row.id + 1],
    })).resolves.toEqual([
      {
        trashId: row.id,
        status: 'unreadable',
        errorType: 'invalidTrashSnapshot',
      },
      { trashId: row.id + 1, status: 'missing' },
    ]);
  });
});
