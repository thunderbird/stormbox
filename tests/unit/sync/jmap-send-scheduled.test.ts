/**
 * Scheduled (Send Later) branch of the shared durable send operation:
 * the Email lands in the real Scheduled mailbox wearing its target
 * sentAt and $seen, the submission carries an RFC 4865 HOLDFOR envelope
 * parameter with no onSuccessUpdateEmail, capability/limit failures are
 * terminal and rewind the phase-1 Email, and crash resume relies on
 * submission-record evidence only — never on mailbox placement.
 */

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { MUTATION_TYPE, SEND_PHASE } from '../../../src/constants/states';
import { MUTATION_TYPES, processMutationRow } from '../../../src/sync/backends/jmap/outbox';
import { JMAP_CAPS } from '../../../src/sync/backends/jmap/transport';
import { MockTransport } from './_mock-transport';

const MAX_DELAYED_SEND = 7 * 24 * 60 * 60;
const TARGET_AT = new Date(Date.now() + 60 * 60_000).toISOString();

let engine;
let handlers;
let account;
let drafts;
let sent;
let scheduled;
let identity;

function sessionWithSubmission(capability: any = {
  maxDelayedSend: MAX_DELAYED_SEND,
  submissionExtensions: { FUTURERELEASE: [] },
}) {
  return {
    capabilities: {
      [JMAP_CAPS.CORE]: { maxObjectsInGet: 500, maxObjectsInSet: 500 },
    },
    accounts: {
      'acct-1': {
        accountCapabilities: {
          [JMAP_CAPS.SUBMISSION]: capability,
        },
      },
    },
  };
}

function scheduledEmail(id: string) {
  return {
    id,
    blobId: `b-${id}`,
    threadId: 'thr-new',
    mailboxIds: { 'mb-sched': true },
    keywords: { $seen: true },
    size: 100,
    receivedAt: new Date().toISOString(),
    sentAt: TARGET_AT,
    messageId: [`<${id}@example.com>`],
    from: [{ email: 'tester@example.com' }],
    to: [{ email: 'rcpt@example.com' }],
    subject: 'Hello',
    preview: 'Hi.',
    hasAttachment: false,
  };
}

/** Transport answering the whole happy path; records the writes. */
function scheduledSendTransport(session = sessionWithSubmission()) {
  const t = new MockTransport(session);
  const calls: Record<string, any[]> = { emailSet: [], submissionSet: [] };
  t.handle('Email/set', (params) => {
    calls.emailSet.push(params);
    if (params.destroy) {
      return { destroyed: params.destroy };
    }
    return { created: { c1: { id: 'em-new', threadId: 'thr-new', size: 100 } } };
  });
  t.handle('EmailSubmission/set', (params) => {
    calls.submissionSet.push(params);
    return { created: { s1: { id: 'sub-new' } } };
  });
  t.handle('Email/get', (params) => ({
    list: (params.ids ?? []).map(scheduledEmail),
    notFound: [],
    state: 'es',
  }));
  t.handle('Mailbox/get', (params) => ({
    list: (params.ids ?? []).map((id) => ({
      id,
      name: id === 'mb-sched' ? 'Scheduled' : id,
      parentId: null,
      role: null,
      isSubscribed: false,
    })),
    notFound: [],
    state: 'ms',
  }));
  t.handle('EmailSubmission/get', () => ({
    list: [],
    notFound: [],
    state: 'subs',
  }));
  return { transport: t, calls };
}

function scheduledSendRow({
  id = 9001,
  phase = null,
  checkpoint = null,
  request = {},
}: any = {}) {
  return {
    id,
    phase,
    ...(checkpoint ? { server_response_json: JSON.stringify(checkpoint) } : {}),
    mutation_type: MUTATION_TYPES.SEND,
    request_json: JSON.stringify({
      identityId: identity.id,
      to: [{ email: 'rcpt@example.com' }],
      subject: 'Hello',
      textBody: 'Hi.',
      draftsFolderId: drafts.id,
      sentFolderId: sent.id,
      outboxFolderId: null,
      scheduledAt: TARGET_AT,
      ...request,
    }),
  };
}

beforeEach(async () => {
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
  account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'T',
    primaryEmail: 't@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: 'acct-1',
    isPrimary: true,
  })).row;
  await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
    accountId: account.id,
    folders: [
      { remoteId: 'mb-drafts', name: 'Drafts', role: 'drafts', sortOrder: 1 },
      { remoteId: 'mb-sent', name: 'Sent', role: 'sent', sortOrder: 2 },
      {
        remoteId: 'mb-sched', name: 'Scheduled', role: null, sortOrder: 3, isSubscribed: false,
      },
    ],
  });
  await handlers[DB_RPC.SETTINGS_APPLY_PATCH]({
    accountId: account.id,
    patch: { scheduledMailboxRemoteId: 'mb-sched' },
  });
  await handlers[DB_RPC.IDENTITY_UPSERT_MANY]({
    accountId: account.id,
    identities: [{
      remoteId: 'id-1',
      name: 'Tester',
      email: 'tester@example.com',
      replyToJson: null,
      rawJson: null,
    }],
  });
  drafts = await engine.get(
    "SELECT id FROM folders WHERE account_id = ? AND remote_id = 'mb-drafts'", [account.id],
  );
  sent = await engine.get(
    "SELECT id FROM folders WHERE account_id = ? AND remote_id = 'mb-sent'", [account.id],
  );
  scheduled = await engine.get(
    "SELECT id FROM folders WHERE account_id = ? AND remote_id = 'mb-sched'", [account.id],
  );
  identity = await engine.get(
    "SELECT id FROM identities WHERE account_id = ? AND remote_id = 'id-1'", [account.id],
  );
  // An open Scheduled mailbox window so local filing lands in real rows.
  const ts = Date.now();
  await engine.run(
    `INSERT INTO query_views(
       account_id, view_type, folder_id, filter_json, sort_json,
       query_state, total, created_at, updated_at, last_accessed_at
     ) VALUES (?, 'mailbox-window', ?, '{}', '[]', 'qs', 0, ?, ?, ?)`,
    [account.id, scheduled.id, ts, ts, ts],
  );
});

afterEach(async () => {
  await engine.close();
});

describe('scheduled send (shared SEND operation)', () => {
  it('creates in Scheduled with target sentAt + $seen and holds the submission', async () => {
    const { transport, calls } = scheduledSendTransport();

    const result = await processMutationRow({
      transport, account, handlers, row: scheduledSendRow(),
    });

    expect(result.ok).toBe(true);

    const create = calls.emailSet.find((p) => p.create)?.create?.c1;
    expect(create.mailboxIds).toEqual({ 'mb-sched': true });
    expect(create.sentAt).toBe(TARGET_AT);
    expect(create.keywords).toEqual({ $seen: true });

    const submit = calls.submissionSet[0];
    const holdFor = Number(submit.create.s1.envelope.mailFrom.parameters.HOLDFOR);
    // The target sits an hour out; HOLDFOR must round up toward it and
    // stay within the advertised limit.
    expect(holdFor).toBeGreaterThan(3500);
    expect(holdFor).toBeLessThanOrEqual(MAX_DELAYED_SEND);
    // The Email already sits in its final mailbox; nothing to move on
    // acceptance.
    expect(submit.onSuccessUpdateEmail).toBeUndefined();

    // Local outcome: pending scheduling columns on a normal cached row,
    // filed in the Scheduled folder, and a subscribe enqueued because
    // the mailbox was hidden.
    const row = await engine.get(
      "SELECT * FROM messages WHERE account_id = ? AND remote_id = 'em-new'",
      [account.id],
    );
    expect(row.scheduled_undo_status).toBe('pending');
    expect(row.scheduled_submission_remote_id).toBe('sub-new');
    const placements = await engine.all(
      'SELECT folder_id FROM folder_messages WHERE message_id = ?', [row.id],
    );
    expect(placements.map((p) => Number(p.folder_id))).toEqual([scheduled.id]);
    const subs = await engine.all(
      'SELECT request_json FROM pending_mutations WHERE account_id = ? AND mutation_type = ?',
      [account.id, MUTATION_TYPE.SET_MAILBOX_SUBSCRIPTION],
    );
    expect(subs.map((s) => JSON.parse(s.request_json))).toEqual([
      {
        folderId: scheduled.id,
        isSubscribed: true,
        managedBy: 'scheduledMailbox',
      },
    ]);
  });

  it.each([
    {
      name: 'FUTURERELEASE not advertised',
      capability: { maxDelayedSend: MAX_DELAYED_SEND },
      scheduledAt: TARGET_AT,
      errorType: 'scheduleCapabilityUnavailable',
    },
    {
      name: 'target already passed',
      capability: { maxDelayedSend: MAX_DELAYED_SEND, submissionExtensions: { FUTURERELEASE: [] } },
      scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      errorType: 'scheduleExpired',
    },
    {
      name: 'target beyond maxDelayedSend',
      capability: { maxDelayedSend: 60, submissionExtensions: { FUTURERELEASE: [] } },
      scheduledAt: TARGET_AT,
      errorType: 'scheduleTooFar',
    },
  ])('rejects terminally and destroys the phase-1 Email: $name', async ({
    capability, scheduledAt, errorType,
  }) => {
    const { transport, calls } = scheduledSendTransport(sessionWithSubmission(capability));
    const row = scheduledSendRow();
    row.request_json = JSON.stringify({
      ...JSON.parse(row.request_json),
      scheduledAt,
    });

    const result = await processMutationRow({ transport, account, handlers, row });

    expect(result.ok).toBe(false);
    expect(result.error.type).toBe(errorType);
    expect(result.error.terminal).toBe(true);
    // Definitive rejection before submission: no submission created, and
    // the created Email was destroyed so no orphan lingers in Scheduled.
    expect(calls.submissionSet).toHaveLength(0);
    const destroys = calls.emailSet.filter((p) => p.destroy);
    expect(destroys).toHaveLength(1);
    expect(destroys[0].destroy).toEqual(['em-new']);
  });

  it('parks an interrupted submission as unknown without trusting placement', async () => {
    // Resume from SUBMITTING with the Email known but the submission
    // response lost. For a scheduled send the Email has sat in the
    // Scheduled mailbox since phase 1, so placement proves nothing; with
    // no retained submission record the only safe answer is unknown.
    const { transport, calls } = scheduledSendTransport();
    const emailGetCalls: any[] = [];
    transport.handle('EmailSubmission/query', () => ({
      ids: [], position: 0, total: 0, canCalculateChanges: false, queryState: 'sq',
    }));
    transport.handle('EmailSubmission/get', () => ({
      list: [], notFound: [], state: 'sg',
    }));
    transport.handle('Email/get', (params) => {
      emailGetCalls.push(params);
      return { list: (params.ids ?? []).map(scheduledEmail), state: 'es' };
    });

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: scheduledSendRow({
        phase: SEND_PHASE.SUBMITTING,
        checkpoint: {
          operationId: 'op-1', messageId: '<m-1@example.com>', emailRemoteId: 'em-new',
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('outcomeUnknown');
    expect(result.error.reason).toBe('noEvidence');
    // The placement probe (signal 2) must not have run: it would have
    // found the Email in Scheduled and proven nothing.
    expect(emailGetCalls).toHaveLength(0);
    expect(calls.submissionSet).toHaveLength(0);
  });

  it('resumes an interrupted submission from a retained record', async () => {
    const { transport, calls } = scheduledSendTransport();
    transport.handle('EmailSubmission/query', () => ({
      ids: ['sub-found'], position: 0, total: 1, canCalculateChanges: false, queryState: 'sq',
    }));
    transport.handle('EmailSubmission/get', () => ({
      list: [{
        id: 'sub-found',
        emailId: 'em-new',
        undoStatus: 'pending',
        sendAt: TARGET_AT,
      }],
      notFound: [],
      state: 'sg',
    }));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: scheduledSendRow({
        phase: SEND_PHASE.SUBMITTING,
        checkpoint: {
          operationId: 'op-1', messageId: '<m-1@example.com>', emailRemoteId: 'em-new',
        },
      }),
    });

    expect(result.ok).toBe(true);
    // Evidence, not resubmission: no second EmailSubmission/set.
    expect(calls.submissionSet).toHaveLength(0);
    const row = await engine.get(
      "SELECT * FROM messages WHERE account_id = ? AND remote_id = 'em-new'",
      [account.id],
    );
    expect(row.scheduled_undo_status).toBe('pending');
    expect(row.scheduled_submission_remote_id).toBe('sub-found');
  });

  it('defers scheduled attachment bodies to the normal on-demand loader', async () => {
    const { transport } = scheduledSendTransport();
    const persistBody = vi.fn();
    const failingHandlers = {
      ...handlers,
      [DB_RPC.MESSAGE_BODY_PERSIST_BATCH]: persistBody,
    };

    const result = await processMutationRow({
      transport,
      account,
      handlers: failingHandlers,
      row: scheduledSendRow({
        request: {
          attachments: [{
            part_id: null,
            blob_id: 'blob-attachment',
            mime_type: 'application/pdf',
            name: 'attachment.pdf',
            size: 3,
            disposition: 'attachment',
            cid: null,
          }],
        },
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        createdRemoteId: 'em-new',
        submissionRemoteId: 'sub-new',
        filed: true,
      },
    });
    expect(persistBody).not.toHaveBeenCalled();
    const row = await engine.get(
      "SELECT * FROM messages WHERE account_id = ? AND remote_id = 'em-new'",
      [account.id],
    );
    expect(row).toMatchObject({
      scheduled_undo_status: 'pending',
      scheduled_submission_remote_id: 'sub-new',
    });
  });
});
