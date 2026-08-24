// @vitest-environment happy-dom

import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import { __resetRepositoryForTests, __setRepositoryForTests } from '../../../src/composables/useRepository';
import { COMPOSE_STATE } from '../../../src/constants/states';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useComposeStore } from '../../../src/stores/compose-store';
import type { IdentityRow } from '../../../src/types';

function identity(overrides: Partial<IdentityRow>): IdentityRow {
  return {
    id: overrides.id ?? 1,
    account_id: overrides.account_id ?? 1,
    remote_id: overrides.remote_id ?? `id-${overrides.id ?? 1}`,
    name: overrides.name ?? null,
    email: overrides.email ?? 'user@example.com',
    reply_to_json: overrides.reply_to_json ?? null,
    raw_json: overrides.raw_json ?? null,
    updated_at: overrides.updated_at ?? 0,
  };
}

async function waitForAsyncWatchers() {
  await Promise.resolve();
  await Promise.resolve();
}

function sourceMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    subject: 'Project update',
    from_text: 'Alice <alice@example.com>',
    to_text: 'Me <me@example.com>, Bob <bob@example.com>, Alice <alice@example.com>',
    rfc822_message_id: 'parent@example.com',
    references_json: null,
    in_reply_to_json: null,
    received_at: Date.parse('2026-05-22T12:00:00Z'),
    ...overrides,
  } as any;
}

/**
 * The parent's `message_addresses` rows, which is where the reply audience
 * comes from. `to_text` above is the display string for the same people;
 * the two are kept consistent so a test reads as one message.
 */
function sourceAddresses() {
  return [
    { kind: 'from', position: 0, name: 'Alice', email: 'alice@example.com' },
    { kind: 'to', position: 0, name: 'Me', email: 'me@example.com' },
    { kind: 'to', position: 1, name: 'Bob', email: 'bob@example.com' },
    { kind: 'to', position: 2, name: 'Alice', email: 'alice@example.com' },
    { kind: 'cc', position: 0, name: 'Carol', email: 'carol@example.com' },
  ];
}

/**
 * A store attached to a repository that answers the address read the reply
 * prefills depend on.
 */
async function storeWithParentAddresses(addresses = sourceAddresses(), identities = [
  identity({ id: 1, name: 'Me', email: 'me@example.com' }),
]) {
  const repo = {
    subscribe: vi.fn(() => () => {}),
    getAccount: vi.fn(async () => ({ id: 1, primary_email: 'me@example.com' })),
    listIdentities: vi.fn(async () => identities),
    ensureIdentities: vi.fn(async () => {}),
    listMessageAddresses: vi.fn(async () => addresses),
  };
  __setRepositoryForTests(repo);
  const authStore = useAuthStore();
  authStore.accountId = 1;
  const composeStore = useComposeStore();
  await composeStore.attach();
  await waitForAsyncWatchers();
  return { composeStore, repo };
}

beforeEach(() => {
  setActivePinia(createPinia());
  __resetRepositoryForTests();
  window.localStorage.clear();
});

describe('compose-store reply and forward prefills', () => {
  it('prepares a reply addressed to the original sender with quoted content', async () => {
    const { composeStore } = await storeWithParentAddresses();

    await composeStore.prepareReplyFromMessage(sourceMessage(), {
      html: '<p>Hello from Alice</p>',
      text: 'Hello from Alice',
    });

    expect(composeStore.isOpen).toBe(true);
    expect(composeStore.draft.to).toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
    expect(composeStore.draft.cc).toEqual([]);
    expect(composeStore.draft.subject).toBe('Re: Project update');
    expect(composeStore.draft.htmlBody).toContain('From: Alice &lt;alice@example.com&gt;');
    expect(composeStore.draft.htmlBody).toContain('<blockquote type="cite"><p>Hello from Alice</p></blockquote>');
    expect(composeStore.draft.textBody).toContain('> Hello from Alice');
  });

  it('prepares reply-all with the sender in To and everyone else in Cc', async () => {
    const { composeStore } = await storeWithParentAddresses();

    await composeStore.prepareReplyAll(sourceMessage(), {
      text: 'Looping everyone in',
    });

    expect(composeStore.isOpen).toBe(true);
    expect(composeStore.draft.to).toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
    expect(composeStore.draft.cc, 'the original Cc travels too (issue #71)').toEqual([
      { name: 'Bob', email: 'bob@example.com' },
      { name: 'Carol', email: 'carol@example.com' },
    ]);
    expect(composeStore.draft.textBody).toContain('> Looping everyone in');
  });

  it('threads a reply to its parent', async () => {
    const { composeStore } = await storeWithParentAddresses();

    await composeStore.prepareReplyFromMessage(
      sourceMessage({ references_json: JSON.stringify(['first@example.com']) }),
      {},
    );

    expect(composeStore.draft.inReplyTo).toEqual(['parent@example.com']);
    expect(composeStore.draft.references).toEqual([
      'first@example.com',
      'parent@example.com',
    ]);
  });

  it('reads the audience from the addresses of the message being replied to', async () => {
    const { composeStore, repo } = await storeWithParentAddresses();

    await composeStore.prepareReplyAll(sourceMessage({ id: 99 }), {});

    expect(repo.listMessageAddresses).toHaveBeenCalledWith(99);
  });

  it('leaves out every address the account owns, whichever From is selected', async () => {
    // The audience is computed from what the account owns, not from the
    // identity the draft happens to be sending as, so a reply from an alias
    // still does not address the user's other alias.
    const { composeStore } = await storeWithParentAddresses(
      [
        ...sourceAddresses(),
        { kind: 'cc', position: 1, name: 'Me at work', email: 'work@example.com' },
      ],
      [
        identity({ id: 1, name: 'Me', email: 'me@example.com' }),
        identity({ id: 2, name: 'Me at work', email: 'work@example.com' }),
      ],
    );

    await composeStore.prepareReplyAll(sourceMessage(), {});
    composeStore.draft.fromIdx = 1;

    const addressed = [...composeStore.draft.to, ...composeStore.draft.cc]
      .map((a: any) => a.email);
    expect(addressed).not.toContain('me@example.com');
    expect(addressed).not.toContain('work@example.com');
    expect(addressed).toEqual(['alice@example.com', 'bob@example.com', 'carol@example.com']);
  });

  it('falls back to a narrow reply when the parent addresses cannot be read', async () => {
    // An empty audience would look like a message addressed to nobody, and
    // a reply-all computed from nothing would silently drop every
    // recipient. The sender is the one address the list row can supply.
    const { composeStore, repo } = await storeWithParentAddresses();
    repo.listMessageAddresses.mockRejectedValueOnce(new Error('worker gone'));

    await composeStore.prepareReplyAll(sourceMessage(), {});

    expect(composeStore.draft.to).toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
    expect(composeStore.draft.cc).toEqual([]);
  });

  it('opens the reply the user asked for last, not the read that finishes last', async () => {
    // Each reply reads its parent's addresses before it can open, and two
    // quick gestures settle in completion order. With a slow read for the
    // first message, the composer ended up quoting and addressing the one
    // the user had already left behind.
    const { composeStore, repo } = await storeWithParentAddresses();
    let releaseFirst = () => {};
    repo.listMessageAddresses
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return [{ kind: 'from', position: 0, name: 'Alice', email: 'alice@example.com' }];
      })
      .mockImplementationOnce(async () => (
        [{ kind: 'from', position: 0, name: 'Carol', email: 'carol@example.com' }]
      ));

    const first = composeStore.prepareReplyFromMessage(
      sourceMessage({ id: 1, subject: 'The one abandoned' }),
      { text: 'From Alice' },
    );
    const second = composeStore.prepareReplyFromMessage(
      sourceMessage({ id: 2, subject: 'The one wanted' }),
      { text: 'From Carol' },
    );
    await second;
    releaseFirst();
    await first;

    expect(composeStore.draft.to).toEqual([{ name: 'Carol', email: 'carol@example.com' }]);
    expect(composeStore.draft.subject).toBe('Re: The one wanted');
    expect(composeStore.draft.textBody).toContain('> From Carol');
    expect(composeStore.draft.textBody).not.toContain('From Alice');
  });

  it('prepares a forward without recipients and with a forwarded subject', async () => {
    const { composeStore } = await storeWithParentAddresses();

    composeStore.prepareForward(sourceMessage(), {
      html: '<p>Forward this</p>',
      text: 'Forward this',
    });

    expect(composeStore.isOpen).toBe(true);
    expect(composeStore.draft.to).toEqual([]);
    expect(composeStore.draft.cc).toEqual([]);
    expect(composeStore.draft.inReplyTo).toEqual([]);
    expect(composeStore.draft.subject).toBe('Fwd: Project update');
    expect(composeStore.draft.htmlBody).toContain('<blockquote type="cite"><p>Forward this</p></blockquote>');
    expect(composeStore.draft.textBody).toContain('> Forward this');
  });
});

describe('compose-store recipient fields', () => {
  it('takes the addresses from committed recipients', () => {
    const composeStore = useComposeStore();
    composeStore.open();

    composeStore.setRecipientEntries('to', [
      { name: 'Smith, Alice', email: 'alice@example.com' },
      { email: 'bob@example.com' },
    ]);

    expect(composeStore.draft.to).toEqual([
      { name: 'Smith, Alice', email: 'alice@example.com' },
      { email: 'bob@example.com' },
    ]);
    expect(composeStore.rejectedRecipients.to).toEqual([]);
  });

  it('keeps a committed recipient that is not an address out of the message', () => {
    const composeStore = useComposeStore();
    composeStore.open();

    composeStore.setRecipientEntries('cc', [
      { email: 'alice@example.com' },
      { text: 'not an address', invalid: true },
    ]);

    // What the message carries is the addresses; what stops it being sent is
    // the presence of anything else (CS-2.4).
    expect(composeStore.draft.cc).toEqual([{ email: 'alice@example.com' }]);
    expect(composeStore.rejectedRecipients.cc).toEqual(['not an address']);
  });

  it('holds no reference to the entries a control handed it', () => {
    // The control keeps its own copy and mutates it in place; a draft that
    // shared the objects would change under the message being sent.
    const composeStore = useComposeStore();
    composeStore.open();
    const entries = [{ name: 'Alice', email: 'alice@example.com' }];

    composeStore.setRecipientEntries('to', entries);
    entries[0].email = 'someone-else@example.com';

    expect(composeStore.draft.to).toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
  });

  it('hands a replaced draft back as recipients a control can show', () => {
    const composeStore = useComposeStore();
    composeStore.open({ to: [{ name: 'Smith, Alice', email: 'alice@example.com' }] });
    composeStore.setRecipientEntries('to', [
      ...composeStore.recipientEntries('to'),
      { text: 'rubbish', invalid: true },
    ]);

    expect(composeStore.recipientEntries('to')).toEqual([
      { name: 'Smith, Alice', email: 'alice@example.com' },
      { text: 'rubbish', invalid: true },
    ]);
  });

  it('counts recipients across all three fields', () => {
    const composeStore = useComposeStore();
    composeStore.open({
      cc: [{ email: 'cc@example.com' }],
      bcc: [{ email: 'bcc@example.com' }],
    });

    expect(composeStore.recipientCount).toBe(2);
  });

  it('does not share recipient arrays between drafts', () => {
    const composeStore = useComposeStore();
    const prefill = [{ email: 'alice@example.com' }];

    composeStore.open({ to: prefill });
    composeStore.setRecipientEntries('to', [{ email: 'bob@example.com' }]);
    composeStore.close();
    composeStore.open({ to: prefill });

    expect(prefill).toEqual([{ email: 'alice@example.com' }]);
    expect(composeStore.draft.to).toEqual([{ email: 'alice@example.com' }]);
  });

  it('clears rejected fragments when the draft is replaced', () => {
    const composeStore = useComposeStore();
    composeStore.open();
    composeStore.setRecipientEntries('to', [{ text: 'rubbish', invalid: true }]);
    expect(composeStore.rejectedRecipients.to).toEqual(['rubbish']);

    composeStore.close();

    expect(composeStore.rejectedRecipients.to).toEqual([]);
  });
});

describe('compose-store from identity selection', () => {
  async function attachedStore({
    primaryEmail = 'primary@thundermail.com',
    identities,
  }: {
    primaryEmail?: string | null;
    identities: IdentityRow[];
  }) {
    let currentIdentities = identities;
    const repo = {
      subscribe: vi.fn(() => () => {}),
      getAccount: vi.fn(async () => ({ id: 1, primary_email: primaryEmail })),
      listIdentities: vi.fn(async () => currentIdentities),
      ensureIdentities: vi.fn(async () => {}),
      setIdentities(next: IdentityRow[]) {
        currentIdentities = next;
      },
    };
    __setRepositoryForTests(repo);

    const authStore = useAuthStore();
    authStore.accountId = 1;
    const composeStore = useComposeStore();
    await composeStore.attach();
    await waitForAsyncWatchers();

    return { composeStore, repo };
  }

  it('opens new compose windows from the account primary identity', async () => {
    const { composeStore } = await attachedStore({
      identities: [
        identity({ id: 1, remote_id: 'alias', email: 'alias@example.com' }),
        identity({ id: 2, remote_id: 'primary', email: 'primary@thundermail.com' }),
      ],
    });

    composeStore.open();

    expect(composeStore.draft.fromIdx).toBe(1);
    expect(composeStore.fromIdentity?.email).toBe('primary@thundermail.com');
  });

  it('asks the server for the identity list each time compose opens', async () => {
    // CS-4.6: an alias added on another device does not exist locally until
    // something fetches it, and the list was only ever read at login — so
    // using a new address meant restarting the app.
    const { composeStore, repo } = await attachedStore({
      identities: [identity({ id: 1, remote_id: 'primary', email: 'primary@thundermail.com' })],
    });

    composeStore.open();

    expect(repo.ensureIdentities).toHaveBeenCalledWith(1);
  });

  it('shows the identities it already has without waiting for the server', async () => {
    // The refresh is behind what is on screen, not in front of it: a slow
    // or unreachable server must not leave the From picker empty.
    const { composeStore, repo } = await attachedStore({
      identities: [identity({ id: 1, remote_id: 'primary', email: 'primary@thundermail.com' })],
    });
    let releaseServer: () => void = () => {};
    repo.ensureIdentities.mockImplementation(
      () => new Promise<void>((resolve) => { releaseServer = resolve; }),
    );

    composeStore.open();

    expect(composeStore.fromIdentity?.email).toBe('primary@thundermail.com');
    releaseServer();
  });

  it('opens anyway when the identity refresh fails', async () => {
    const { composeStore, repo } = await attachedStore({
      identities: [identity({ id: 1, remote_id: 'primary', email: 'primary@thundermail.com' })],
    });
    repo.ensureIdentities.mockRejectedValue(new Error('offline'));

    composeStore.open();
    await waitForAsyncWatchers();

    expect(composeStore.isOpen).toBe(true);
    expect(composeStore.error).toBeNull();
  });

  it('remembers an explicitly selected From identity for later compose windows', async () => {
    const { composeStore } = await attachedStore({
      identities: [
        identity({ id: 1, remote_id: 'alias', email: 'alias@example.com' }),
        identity({ id: 2, remote_id: 'primary', email: 'primary@thundermail.com' }),
      ],
    });

    composeStore.open();
    composeStore.selectFromIndex(0);
    composeStore.close();
    composeStore.open();

    expect(composeStore.draft.fromIdx).toBe(0);
    expect(composeStore.fromIdentity?.remote_id).toBe('alias');
  });

  it('applies the primary identity when identities arrive after compose opens', async () => {
    const { composeStore, repo } = await attachedStore({ identities: [] });

    composeStore.open();
    expect(composeStore.draft.fromIdx).toBe(0);

    repo.setIdentities([
      identity({ id: 1, remote_id: 'alias', email: 'alias@example.com' }),
      identity({ id: 2, remote_id: 'primary', email: 'primary@thundermail.com' }),
    ]);
    await composeStore.refreshIdentities();

    expect(composeStore.draft.fromIdx).toBe(1);
    expect(composeStore.fromIdentity?.email).toBe('primary@thundermail.com');
  });

  it('preserves a selected identity when the refreshed list order changes', async () => {
    const { composeStore, repo } = await attachedStore({
      identities: [
        identity({ id: 1, remote_id: 'alias', email: 'alias@example.com' }),
        identity({ id: 2, remote_id: 'primary', email: 'primary@thundermail.com' }),
      ],
    });

    composeStore.open();
    composeStore.selectFromIndex(0);
    repo.setIdentities([
      identity({ id: 2, remote_id: 'primary', email: 'primary@thundermail.com' }),
      identity({ id: 1, remote_id: 'alias', email: 'alias@example.com' }),
    ]);
    await composeStore.refreshIdentities();

    expect(composeStore.draft.fromIdx).toBe(1);
    expect(composeStore.fromIdentity?.remote_id).toBe('alias');
  });
});

describe('compose-store send safety', () => {
  it('refuses to discard the draft while a send is in flight', () => {
    // The queued mutation keeps running in the worker after the dialog
    // closes, and its request payload is the only durable copy of the
    // message, so discarding here could lose the user's mail outright.
    const composeStore = useComposeStore();
    composeStore.open({ to: [{ email: 'rcpt@example.com' }], subject: 'Keep me' });
    composeStore.status = COMPOSE_STATE.SENDING;

    expect(composeStore.close()).toBe(false);
    expect(composeStore.isOpen).toBe(true);
    expect(composeStore.draft.subject).toBe('Keep me');
    expect(composeStore.draft.to).toEqual([{ email: 'rcpt@example.com' }]);
  });

  it('does not let a send settling after logout write over a new composer', async () => {
    // Neither $reset() nor the accountId watcher waits for an in-flight
    // send, so its eventual result must prove it still belongs to the
    // current composer before touching shared state.
    let releaseMutation: (v: any) => void = () => {};
    const repo = {
      subscribe: vi.fn(() => () => {}),
      getAccount: vi.fn(async () => ({ id: 1, primary_email: 'me@example.com' })),
      listIdentities: vi.fn(async () => [identity({ id: 1, email: 'me@example.com' })]),
      ensureIdentities: vi.fn(async () => {}),
      insertPendingMutation: vi.fn(async () => ({ id: 7 })),
      runMutation: vi.fn(() => new Promise((resolve) => { releaseMutation = resolve; })),
    };
    __setRepositoryForTests(repo);
    const authStore = useAuthStore();
    authStore.accountId = 1;
    const composeStore = useComposeStore();
    await composeStore.attach();
    await waitForAsyncWatchers();

    composeStore.open({ to: [{ email: 'rcpt@example.com' }], subject: 'First' });
    const sending = composeStore.send();
    await waitForAsyncWatchers();
    expect(composeStore.status).toBe(COMPOSE_STATE.SENDING);

    // Logout, then the user opens a fresh composer.
    composeStore.$reset();
    composeStore.open({ subject: 'Second' });

    releaseMutation({ attempted: 1, succeeded: 0, failed: 1 });
    await sending;

    // The stale failure must not have overwritten the new composer.
    expect(composeStore.status).toBe(COMPOSE_STATE.EDITING);
    expect(composeStore.error).toBeNull();
    expect(composeStore.draft.subject).toBe('Second');
  });

  it('closes normally once the send has settled', () => {
    const composeStore = useComposeStore();
    composeStore.open({ subject: 'Done' });
    composeStore.status = COMPOSE_STATE.FAILED;

    expect(composeStore.close()).toBe(true);
    expect(composeStore.isOpen).toBe(false);
    expect(composeStore.draft.subject).toBe('');
  });

  /**
   * A composer wired to a repo whose runMutation returns `outcome`, and
   * whose failed row carries `rowError` as its recorded error.
   */
  /** The repository the most recent composerWithOutcome() wired up. */
  let lastRepo: any = null;

  async function composerWithOutcome(
    outcome: Record<string, unknown>,
    rowError?: Record<string, unknown>,
    identities: IdentityRow[] = [identity({ id: 1, email: 'me@example.com' })],
    rowCheckpoint?: Record<string, unknown>,
  ) {
    const repo = {
      subscribe: vi.fn(() => () => {}),
      getAccount: vi.fn(async () => ({ id: 1, primary_email: 'me@example.com' })),
      listIdentities: vi.fn(async () => identities),
      ensureIdentities: vi.fn(async () => {}),
      insertPendingMutation: vi.fn(async () => ({ id: 7 })),
      runMutation: vi.fn(async () => outcome),
      getPendingMutationError: vi.fn(async () => (rowError
        ? {
          mutation_type: 'send',
          local_status: 'conflicted',
          error_json: JSON.stringify(rowError),
          server_response_json: rowCheckpoint ? JSON.stringify(rowCheckpoint) : null,
        }
        : null)),
    };
    lastRepo = repo;
    __setRepositoryForTests(repo);
    const authStore = useAuthStore();
    authStore.accountId = 1;
    const composeStore = useComposeStore();
    await composeStore.attach();
    await waitForAsyncWatchers();
    return composeStore;
  }

  /** The parsed request payload of the single mutation that was queued. */
  function queuedSend() {
    return JSON.parse(lastRepo.insertPendingMutation.mock.calls[0][0].requestJson);
  }

  it('queues at most one mutation while a send is in flight', async () => {
    const composeStore = await composerWithOutcome({
      attempted: 1, succeeded: 1, failed: 0, result: { filed: true },
    });
    composeStore.open({ to: [{ email: 'rcpt@example.com' }] });

    const firstSend = composeStore.send();

    await expect(composeStore.send()).resolves.toBe(false);
    await expect(firstSend).resolves.toBe(true);
    expect(lastRepo.insertPendingMutation).toHaveBeenCalledTimes(1);
  });

  it('sends a message addressed only in Cc', async () => {
    // Any of the three fields carries the message; requiring To refuses a
    // send the user has every right to make (CS-2.2).
    const composeStore = await composerWithOutcome({
      attempted: 1, succeeded: 1, failed: 0, result: { filed: true },
    });
    composeStore.open({ cc: [{ email: 'cc@example.com' }], subject: 'Cc only' });

    await expect(composeStore.send()).resolves.toBe(true);
  });

  it('sends a message addressed only in Bcc', async () => {
    const composeStore = await composerWithOutcome({
      attempted: 1, succeeded: 1, failed: 0, result: { filed: true },
    });
    composeStore.open({ bcc: [{ email: 'bcc@example.com' }], subject: 'Bcc only' });

    await expect(composeStore.send()).resolves.toBe(true);
  });

  it('still refuses a send addressed to nobody', async () => {
    const composeStore = await composerWithOutcome({});
    composeStore.open({ subject: 'Nobody' });

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.error).toBe('Add at least one recipient.');
  });

  it('refuses to send while a recipient field holds something unreadable', async () => {
    // Sending anyway would deliver to a smaller audience than the user
    // believes they addressed, and say nothing about it (CS-2.4).
    const composeStore = await composerWithOutcome({});
    composeStore.open({ to: [{ email: 'alice@example.com' }] });
    composeStore.setRecipientEntries('cc', [
      { email: 'alice@example.com' },
      { text: 'not an address', invalid: true },
    ]);

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.error).toBe('not an address is not an email address.');
  });

  it('refuses a send whose recipients an unclosed comment hid', async () => {
    // The worst shape of CS-2.4: comment syntax makes everything after `(`
    // invisible, so this once queued Alice alone with nothing rejected and
    // nothing to stop it, and Bob was simply never mailed.
    const composeStore = await composerWithOutcome({});
    composeStore.open();
    composeStore.setRecipientEntries('to', [
      { text: 'alice@example.com (Bob <bob@example.com>', invalid: true },
    ]);

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.error).toContain('bob@example.com');
    expect(composeStore.draft.to).toEqual([]);
  });

  it('names every unreadable fragment when there is more than one', async () => {
    const composeStore = await composerWithOutcome({});
    composeStore.open();
    composeStore.setRecipientEntries('to', [
      { text: 'first bad', invalid: true },
      { text: 'second@', invalid: true },
    ]);

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.error).toBe('These are not email addresses: first bad, second@');
  });

  it('queues the recipients as addresses, not as text', async () => {
    const composeStore = await composerWithOutcome({
      attempted: 1, succeeded: 1, failed: 0, result: { filed: true },
    });
    composeStore.open({
      to: [{ name: 'Smith, Alice', email: 'alice@example.com' }],
      cc: [{ email: 'cc@example.com' }],
      bcc: [{ email: 'bcc@example.com' }],
    });

    await composeStore.send();

    const request = queuedSend();
    expect(request.to).toEqual([{ name: 'Smith, Alice', email: 'alice@example.com' }]);
    expect(request.cc).toEqual([{ email: 'cc@example.com' }]);
    expect(request.bcc).toEqual([{ email: 'bcc@example.com' }]);
  });

  it('carries the reply threading into the queued send', async () => {
    const composeStore = await composerWithOutcome({
      attempted: 1, succeeded: 1, failed: 0, result: { filed: true },
    });
    composeStore.open({
      to: [{ email: 'alice@example.com' }],
      inReplyTo: ['parent@example.com'],
      references: ['first@example.com', 'parent@example.com'],
    });

    await composeStore.send();

    const request = queuedSend();
    expect(request.inReplyTo).toEqual(['parent@example.com']);
    expect(request.references).toEqual(['first@example.com', 'parent@example.com']);
  });

  it('applies the identity Reply-To default without changing user Bcc', async () => {
    const composeStore = await composerWithOutcome(
      { attempted: 1, succeeded: 1, failed: 0, result: { filed: true } },
      undefined,
      [identity({
        id: 1,
        email: 'me@example.com',
        reply_to_json: JSON.stringify([{ name: 'Replies', email: 'replies@example.com' }]),
      })],
    );
    composeStore.open({ to: [{ email: 'alice@example.com' }] });

    await composeStore.send();

    const request = queuedSend();
    expect(request.replyTo).toEqual([{ name: 'Replies', email: 'replies@example.com' }]);
    expect(request.bcc).toEqual([]);
  });

  it('confirms a send as accepted rather than delivered', async () => {
    // Nothing the client can observe proves the message reached anyone,
    // so the confirmation may only claim what the server told us: it took
    // the message (CS-1.13).
    const composeStore = await composerWithOutcome({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      result: { filed: true },
    });
    composeStore.open({ to: [{ email: 'rcpt@example.com' }], subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(true);
    expect(composeStore.notice).toBe('Message accepted for delivery.');
    expect(composeStore.notice).not.toMatch(/delivered|sent to/i);
  });

  it('reports a message that went out but was not filed as sent', async () => {
    // The failure is local filing, which happens after the point of no
    // return. Calling it a failed send invites a second press of Send, and
    // a second press is a second delivery.
    const composeStore = await composerWithOutcome({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      result: { filed: false, submitted: true },
    });
    composeStore.open({ to: [{ email: 'rcpt@example.com' }], subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(true);
    expect(composeStore.status).toBe(COMPOSE_STATE.IDLE);
    expect(composeStore.isOpen).toBe(false);
    expect(composeStore.error).toBeNull();
    expect(composeStore.notice).toMatch(/accepted for delivery/);
    expect(composeStore.notice).toMatch(/Sent folder/);
  });

  it('still reports a send that never reached the server as failed', async () => {
    const composeStore = await composerWithOutcome({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      result: { filed: false },
    });
    composeStore.open({ to: [{ email: 'rcpt@example.com' }], subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.status).toBe(COMPOSE_STATE.FAILED);
    expect(composeStore.error).toMatch(/Send failed/);
    expect(composeStore.notice).toBeNull();
  });

  it('resolves an unknown outcome through the mailbox when the message is on the server', async () => {
    // The checkpoint proves the Email was created, so the text lives in
    // Drafts or in Sent — the folders show which as they sync. Holding
    // the composer open behind a special state would add nothing the
    // mailbox does not already say (CS-1.9).
    const composeStore = await composerWithOutcome(
      { attempted: 1, succeeded: 0, failed: 1, result: { filed: false } },
      { type: 'outcomeUnknown', terminal: true, reason: 'noEvidence' },
      undefined,
      { operationId: 'op1', messageId: '<m1@example.com>', emailRemoteId: 'M99' },
    );
    composeStore.open({ to: [{ email: 'rcpt@example.com' }], subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.isOpen, 'the folders are where the answer is').toBe(false);
    expect(composeStore.error).toBeNull();
    expect(composeStore.notice).toMatch(/could not confirm/i);
    expect(composeStore.notice).toMatch(/Sent/);
    expect(composeStore.notice).toMatch(/Drafts/);
  });

  it('holds the draft when an unknown outcome left no copy on the server', async () => {
    // No Email id in the checkpoint means this dialog may hold the only
    // reachable copy of the text, so it must not close over it. The copy
    // must not read as a plain failure either — nothing proves the
    // message did not go out — and Send stays offered: resending after
    // checking Sent is the user's decision (CS-1.9).
    const composeStore = await composerWithOutcome(
      { attempted: 1, succeeded: 0, failed: 1, result: { filed: false } },
      { type: 'outcomeUnknown', terminal: true, reason: 'unreadableCheckpoint' },
    );
    composeStore.open({ to: [{ email: 'rcpt@example.com' }], subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.status).toBe(COMPOSE_STATE.FAILED);
    expect(composeStore.isOpen, 'the draft here may be the only copy').toBe(true);
    expect(composeStore.error).toMatch(/could not confirm/i);
    expect(composeStore.error).toMatch(/check your sent folder/i);
    expect(composeStore.error).not.toMatch(/failed/i);
  });

  it('recognises a send parked by crash recovery', async () => {
    // Startup recovery parks an interrupted send itself, without going
    // through the outbox. It records the same type, and the composer has
    // to read it the same way. The row it parks keeps its checkpoint, so
    // one that had created its Email resolves through the mailbox.
    const composeStore = await composerWithOutcome(
      { attempted: 1, succeeded: 0, failed: 1 },
      { type: 'outcomeUnknown', terminal: true, reason: 'interrupted' },
      undefined,
      { operationId: 'op1', messageId: '<m1@example.com>', emailRemoteId: 'M42' },
    );
    composeStore.open({ to: [{ email: 'rcpt@example.com' }], subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.isOpen).toBe(false);
    expect(composeStore.notice).toMatch(/could not confirm/i);
  });

  it('blames the send when the failure was not ambiguous', async () => {
    const composeStore = await composerWithOutcome(
      { attempted: 1, succeeded: 0, failed: 1, result: { filed: false } },
      { type: 'notSubmitted', terminal: true, detail: { type: 'forbiddenFrom' } },
    );
    composeStore.open({ to: [{ email: 'rcpt@example.com' }], subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.error).toMatch(/Send failed/);
    expect(composeStore.isOpen).toBe(true);
  });

  it('does not confirm a send the outbox never got to', async () => {
    // What a stopped runner reports: nothing attempted, nothing failed.
    // Reading that as success would confirm a message still sitting in
    // the queue.
    const composeStore = await composerWithOutcome({ attempted: 0, succeeded: 0, failed: 0 });
    composeStore.open({ to: [{ email: 'rcpt@example.com' }], subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.status).toBe(COMPOSE_STATE.FAILED);
    expect(composeStore.notice).toBeNull();
    expect(composeStore.isOpen, 'the draft is still the only copy').toBe(true);
  });

  it('confirms a send the outbox had already retired', async () => {
    // The row was gone by the time the composer asked, which the runner
    // reports as a success with nothing attempted.
    const composeStore = await composerWithOutcome({ attempted: 0, succeeded: 1, failed: 0 });
    composeStore.open({ to: [{ email: 'rcpt@example.com' }], subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(true);
    expect(composeStore.notice).toMatch(/accepted for delivery/);
  });

  it('takes the outbox at its word when the row is already gone', async () => {
    // A send interrupted by the worker shutting down is reported by the
    // outcome itself, with no row left to consult: the runner knows the
    // mutation was checked out to a worker that is going away, and for a
    // send that is not the same as knowing it failed. With no row there
    // is no checkpoint either, so nothing proves a server copy exists
    // and the composer keeps the draft open.
    const composeStore = await composerWithOutcome({
      attempted: 1, succeeded: 0, failed: 1, errorType: 'outcomeUnknown',
    });
    composeStore.open({ to: [{ email: 'rcpt@example.com' }], subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.isOpen).toBe(true);
    expect(composeStore.error).toMatch(/could not confirm/i);
    expect(composeStore.error).toMatch(/check your sent folder/i);
  });

  it('blames a stopped mutation that was safe to stop', async () => {
    const composeStore = await composerWithOutcome({
      attempted: 1, succeeded: 0, failed: 1, errorType: 'stopped',
    });
    composeStore.open({ to: [{ email: 'rcpt@example.com' }], subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.error).toMatch(/Send failed/);
  });

  it('leaves an unconfirmed send behind when the composer is reused', async () => {
    // The held-open unknown state is advisory, not a lock: the user can
    // still close the dialog, and a new message starts clean.
    const composeStore = await composerWithOutcome(
      { attempted: 1, succeeded: 0, failed: 1, result: { filed: false } },
      { type: 'outcomeUnknown', terminal: true, reason: 'noEvidence' },
    );
    composeStore.open({ to: [{ email: 'rcpt@example.com' }], subject: 'Hello' });
    await composeStore.send();
    expect(composeStore.isOpen).toBe(true);

    expect(composeStore.close()).toBe(true);
    composeStore.open({ to: [{ email: 'other@example.com' }] });
    expect(composeStore.error).toBeNull();
    expect(composeStore.status).toBe(COMPOSE_STATE.EDITING);
  });
});
