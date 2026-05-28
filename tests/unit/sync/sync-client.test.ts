import { describe, it, expect } from 'vitest';

import { SyncClient } from '../../../src/sync/sync-client';
import { SERVICE_KIND } from '../../../src/constants/states';

/**
 * SyncClient is the single dispatch point that routes
 * Repository RPC calls (ensureFolderTree, ensureFolderWindow,
 * runMutation, ...) to the registered backend for the right
 * (account, service-kind) pair. The end-to-end coverage from
 * sync-host exercises only the happy path; this file pins the
 * routing contract and registration error modes so changes here
 * cannot silently break a future second-backend wiring.
 */

function makeBackend(name) {
  const calls = [];
  return {
    name,
    calls,
    async start() { calls.push(['start']); },
    async stop() { calls.push(['stop']); },
    async ensureFolderTree() { calls.push(['ensureFolderTree']); return { count: 0 }; },
    async ensureFolderWindow(folderId, range) {
      calls.push(['ensureFolderWindow', folderId, range]);
    },
    async ensureMessageBody(messageId) { calls.push(['ensureMessageBody', messageId]); },
    async ensureMessageBodies(ids) { calls.push(['ensureMessageBodies', ids]); },
    async ensureMessageBodyForDisplay(id) {
      calls.push(['ensureMessageBodyForDisplay', id]);
      return { fetched: 1 };
    },
    async ensureFolderIndex(folderId, options) {
      calls.push(['ensureFolderIndex', folderId, options]);
    },
    async ensureIdentities() { calls.push(['ensureIdentities']); },
    async ensureQuota() { calls.push(['ensureQuota']); },
    async ensureAddressbooks() { calls.push(['ensureAddressbooks']); },
    async ensureContacts(addressbookId) { calls.push(['ensureContacts', addressbookId]); },
    async runMutation(mutationId) { calls.push(['runMutation', mutationId]); },
  };
}

describe('SyncClient routing', () => {
  it('routes ensure* calls to the JMAP_MAIL backend registered for the account', async () => {
    const client = new SyncClient();
    const mail = makeBackend('mail');
    client.registerBackend(7, SERVICE_KIND.JMAP_MAIL, mail);

    await client.ensureFolderTree(7);
    await client.ensureFolderWindow(7, 42, { offset: 0, limit: 100 });
    await client.ensureMessageBody(7, 9);
    await client.ensureMessageBodies(7, [9, 10]);
    await client.ensureMessageBodyForDisplay(7, 9);
    await client.ensureFolderIndex(7, 42, { yieldToForeground: true });
    await client.ensureIdentities(7);
    await client.ensureQuota(7);
    await client.runMutation(7, SERVICE_KIND.JMAP_MAIL, 99);

    expect(mail.calls).toEqual([
      ['ensureFolderTree'],
      ['ensureFolderWindow', 42, { offset: 0, limit: 100 }],
      ['ensureMessageBody', 9],
      ['ensureMessageBodies', [9, 10]],
      ['ensureMessageBodyForDisplay', 9],
      ['ensureFolderIndex', 42, { yieldToForeground: true }],
      ['ensureIdentities'],
      ['ensureQuota'],
      ['runMutation', 99],
    ]);
  });

  it('routes contacts methods to the JMAP_CONTACTS backend, not the mail backend', async () => {
    const client = new SyncClient();
    const mail = makeBackend('mail');
    const contacts = makeBackend('contacts');
    client.registerBackend(1, SERVICE_KIND.JMAP_MAIL, mail);
    client.registerBackend(1, SERVICE_KIND.JMAP_CONTACTS, contacts);

    await client.ensureAddressbooks(1);
    await client.ensureContacts(1, 5);

    expect(contacts.calls).toEqual([
      ['ensureAddressbooks'],
      ['ensureContacts', 5],
    ]);
    expect(mail.calls).toEqual([]);
  });

  it('throws a descriptive error when no backend is registered for the (account, service-kind) pair', () => {
    const client = new SyncClient();
    expect(() => client.ensureFolderTree(1))
      .toThrow(/No .* backend registered for account 1/);

    client.registerBackend(1, SERVICE_KIND.JMAP_MAIL, makeBackend('mail'));
    expect(() => client.ensureContacts(1, 5))
      .toThrow(/No .* backend registered for account 1/);
  });

  it('startAll / stopAll fan out to every registered backend exactly once', async () => {
    const client = new SyncClient();
    const a = makeBackend('a');
    const b = makeBackend('b');
    client.registerBackend(1, SERVICE_KIND.JMAP_MAIL, a);
    client.registerBackend(2, SERVICE_KIND.JMAP_MAIL, b);

    await client.startAll();
    await client.stopAll();

    expect(a.calls).toEqual([['start'], ['stop']]);
    expect(b.calls).toEqual([['start'], ['stop']]);
  });

  it('unregisterAccount removes every backend for that account so further calls error out', () => {
    const client = new SyncClient();
    client.registerBackend(1, SERVICE_KIND.JMAP_MAIL, makeBackend('mail'));
    client.registerBackend(1, SERVICE_KIND.JMAP_CONTACTS, makeBackend('contacts'));

    client.unregisterAccount(1);

    expect(() => client.ensureFolderTree(1))
      .toThrow(/No .* backend registered for account 1/);
    expect(() => client.ensureAddressbooks(1))
      .toThrow(/No .* backend registered for account 1/);
  });
});
