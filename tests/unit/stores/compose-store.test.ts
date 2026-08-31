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
import { COMPOSE_STATE, MUTATION_TYPE } from '../../../src/constants/states';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useMailStore } from '../../../src/stores/mail-store';
import { useSettingsStore } from '../../../src/stores/settings-store';
import {
  COMPOSE_OPEN_ORIGIN,
  COMPOSE_PRESENTATION,
  useComposeStore,
} from '../../../src/stores/compose-store';
import type { IdentityRow } from '../../../src/types';

function identity(overrides: Partial<IdentityRow>): IdentityRow {
  return {
    id: overrides.id ?? 1,
    account_id: overrides.account_id ?? 1,
    remote_id: overrides.remote_id ?? `id-${overrides.id ?? 1}`,
    name: overrides.name ?? '',
    email: overrides.email ?? 'user@example.com',
    reply_to_json: overrides.reply_to_json ?? null,
    bcc_json: overrides.bcc_json ?? null,
    text_signature: overrides.text_signature ?? null,
    html_signature: overrides.html_signature ?? null,
    may_delete: overrides.may_delete ?? null,
    reply_to: overrides.reply_to ?? null,
    bcc: overrides.bcc ?? null,
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
  let currentIdentities = identities;
  const repo = {
    subscribe: vi.fn(() => () => {}),
    getAccount: vi.fn(async () => ({ id: 1, primary_email: 'me@example.com' })),
    listIdentities: vi.fn(async () => currentIdentities),
    ensureIdentities: vi.fn(async () => {}),
    listMessageAddresses: vi.fn(async () => addresses),
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

  it('replies from the identity matching the original To field', async () => {
    const { composeStore } = await storeWithParentAddresses(
      sourceAddresses(),
      [
        identity({
          id: 1,
          remote_id: 'primary',
          email: 'primary@example.com',
          may_delete: 0,
        }),
        identity({
          id: 2,
          remote_id: 'addressed-alias',
          email: 'me@example.com',
          may_delete: 1,
        }),
      ],
    );

    await composeStore.prepareReplyFromMessage(sourceMessage(), {});

    expect(composeStore.fromIdentity?.remote_id).toBe('addressed-alias');
  });

  it('replies from Primary when the original To field matches no identity', async () => {
    const { composeStore } = await storeWithParentAddresses(
      sourceAddresses().map((address) =>
        address.kind === 'to' ? { ...address, email: 'recipient@example.com' } : address),
      [
        identity({ id: 1, remote_id: 'first', email: 'first@example.com' }),
        identity({ id: 2, remote_id: 'chosen', email: 'chosen@example.com' }),
      ],
    );
    useSettingsStore().settings = { primaryIdentityRemoteId: 'chosen' };

    await composeStore.prepareReplyFromMessage(sourceMessage(), {});

    expect(composeStore.fromIdentity?.remote_id).toBe('chosen');
  });

  it('adopts a matching reply identity when it arrives after the reply opens', async () => {
    const { composeStore, repo } = await storeWithParentAddresses(
      sourceAddresses(),
      [identity({
        id: 1,
        remote_id: 'primary',
        email: 'primary@example.com',
        may_delete: 0,
      })],
    );

    await composeStore.prepareReplyFromMessage(sourceMessage(), {});
    expect(composeStore.fromIdentity?.remote_id).toBe('primary');

    repo.setIdentities([
      identity({
        id: 1,
        remote_id: 'primary',
        email: 'primary@example.com',
        may_delete: 0,
      }),
      identity({
        id: 2,
        remote_id: 'addressed-alias',
        email: 'me@example.com',
        may_delete: 1,
      }),
    ]);
    await composeStore.refreshIdentities();

    expect(composeStore.fromIdentity?.remote_id).toBe('addressed-alias');
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

  it('preserves the order of valid and invalid recipient entries', () => {
    const composeStore = useComposeStore();
    const sessionId = composeStore.open();
    composeStore.setRecipientEntries('to', [
      { email: 'first@example.com' },
      { text: 'unfinished', invalid: true },
      { email: 'last@example.com' },
    ], sessionId);

    expect(composeStore.recipientEntries('to', sessionId)).toEqual([
      { email: 'first@example.com' },
      { text: 'unfinished', invalid: true },
      { email: 'last@example.com' },
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

  it('opens new compose windows from the non-deletable identity by default', async () => {
    const { composeStore } = await attachedStore({
      identities: [
        identity({ id: 1, remote_id: 'alias', email: 'alias@example.com' }),
        identity({
          id: 2,
          remote_id: 'primary',
          email: 'primary@thundermail.com',
          may_delete: 0,
        }),
      ],
    });

    composeStore.open();

    expect(composeStore.draft.fromIdx).toBe(1);
    expect(composeStore.fromIdentity?.email).toBe('primary@thundermail.com');
  });

  it('opens new compose windows from the client-selected Primary identity', async () => {
    const { composeStore } = await attachedStore({
      identities: [
        identity({
          id: 1,
          remote_id: 'server-main',
          email: 'main@example.com',
          may_delete: 0,
        }),
        identity({
          id: 2,
          remote_id: 'selected-primary',
          email: 'alias@example.com',
          may_delete: 1,
        }),
      ],
    });
    useSettingsStore().settings = {
      primaryIdentityRemoteId: 'selected-primary',
    };

    composeStore.open();

    expect(composeStore.fromIdentity?.remote_id).toBe('selected-primary');
  });

  it('updates an automatic From selection when the Primary setting arrives late', async () => {
    const { composeStore } = await attachedStore({
      identities: [
        identity({
          id: 1,
          remote_id: 'server-main',
          email: 'main@example.com',
          may_delete: 0,
        }),
        identity({
          id: 2,
          remote_id: 'synced-primary',
          email: 'alias@example.com',
          may_delete: 1,
        }),
      ],
    });

    composeStore.open();
    expect(composeStore.fromIdentity?.remote_id).toBe('server-main');

    useSettingsStore().settings = { primaryIdentityRemoteId: 'synced-primary' };
    await waitForAsyncWatchers();

    expect(composeStore.fromIdentity?.remote_id).toBe('synced-primary');
  });

  it('does not replace a manually selected From when the Primary setting changes', async () => {
    const { composeStore } = await attachedStore({
      identities: [
        identity({
          id: 1,
          remote_id: 'server-main',
          email: 'main@example.com',
          may_delete: 0,
        }),
        identity({
          id: 2,
          remote_id: 'manual-alias',
          email: 'alias@example.com',
          may_delete: 1,
        }),
      ],
    });

    composeStore.open();
    composeStore.selectFromIndex(1);
    useSettingsStore().settings = { primaryIdentityRemoteId: 'server-main' };
    await waitForAsyncWatchers();

    expect(composeStore.fromIdentity?.remote_id).toBe('manual-alias');
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

  it('uses Primary again after an explicit From selection in an earlier compose window', async () => {
    const { composeStore } = await attachedStore({
      identities: [
        identity({ id: 1, remote_id: 'alias', email: 'alias@example.com' }),
        identity({
          id: 2,
          remote_id: 'primary',
          email: 'primary@thundermail.com',
          may_delete: 0,
        }),
      ],
    });

    composeStore.open();
    composeStore.selectFromIndex(0);
    composeStore.close();
    composeStore.open();

    expect(composeStore.draft.fromIdx).toBe(1);
    expect(composeStore.fromIdentity?.remote_id).toBe('primary');
  });

  it('applies the primary identity when identities arrive after compose opens', async () => {
    const { composeStore, repo } = await attachedStore({ identities: [] });

    composeStore.open();
    expect(composeStore.draft.fromIdx).toBe(0);

    repo.setIdentities([
      identity({ id: 1, remote_id: 'alias', email: 'alias@example.com' }),
      identity({
        id: 2,
        remote_id: 'primary',
        email: 'primary@thundermail.com',
        may_delete: 0,
      }),
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

describe('compose-store identity defaults and provenance', () => {
  async function storeWithIdentityDefaults(initialIdentities: IdentityRow[]) {
    let currentIdentities = initialIdentities;
    const repo = {
      subscribe: vi.fn(() => () => {}),
      getAccount: vi.fn(async () => ({ id: 1, primary_email: initialIdentities[0]?.email ?? null })),
      listIdentities: vi.fn(async () => currentIdentities),
      ensureIdentities: vi.fn(async () => {}),
      listMessageAddresses: vi.fn(async () => sourceAddresses()),
      insertPendingMutation: vi.fn(async () => ({ id: 1 })),
      runMutation: vi.fn(async () => ({
        attempted: 1,
        succeeded: 1,
        failed: 0,
        result: {
          revision: 1,
          emailId: 'draft-1',
          localMessageId: 1,
          messageId: '<draft-1@example.com>',
          payloadHash: 'hash-1',
        },
      })),
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

  const defaultIdentity = () => identity({
    id: 1,
    remote_id: 'default',
    email: 'me@example.com',
    bcc: [
      { name: 'Archive', email: 'archive@example.com' },
      { name: null, email: 'audit@example.com' },
    ],
    html_signature: '<p>Kind regards,<br><b>Andrei</b></p>',
    text_signature: 'Kind regards,\nAndrei',
  });

  it('materializes automatic defaults before a clean, empty seed', async () => {
    vi.useFakeTimers();
    try {
      const { composeStore, repo } = await storeWithIdentityDefaults([defaultIdentity()]);

      const sessionId = composeStore.open();
      const session = composeStore.sessionById(sessionId)!;

      expect(session.draft.bcc).toEqual([
        { name: 'Archive', email: 'archive@example.com' },
        { email: 'audit@example.com' },
      ]);
      expect(session.draft.htmlBody).toContain('Kind regards');
      expect(session.draft.textBody).toBe('Kind regards,\nAndrei');
      expect(session.editorHtmlBody).toContain('data-stormbox-origin="identity-signature"');
      expect(session.draft.htmlBody).not.toContain('data-stormbox-');
      expect(session.seedJson).not.toContain('data-stormbox-');
      expect(composeStore.isSessionDirty(sessionId)).toBe(false);
      expect(composeStore.isSessionMeaningfullyNonEmpty(sessionId)).toBe(false);
      await expect(composeStore.saveDraft(sessionId, { explicit: true })).resolves.toBe(true);
      expect(repo.insertPendingMutation).not.toHaveBeenCalled();

      composeStore.touchSession(sessionId);
      await vi.advanceTimersByTimeAsync(35_000);
      expect(repo.insertPendingMutation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not add automatic Bcc addresses already present in any field', async () => {
    const configured = identity({
      id: 1,
      remote_id: 'default',
      email: 'me@example.com',
      bcc: [
        { name: 'Duplicate To', email: 'DUPLICATE@example.com' },
        { name: 'Unique display', email: 'unique@example.com' },
        { name: 'Repeated unique', email: 'UNIQUE@example.com' },
      ],
    });
    const replacement = identity({
      id: 2,
      remote_id: 'replacement',
      email: 'replacement-sender@example.com',
      bcc: [
        { name: 'Duplicate Cc', email: 'cc@example.com' },
        { name: 'Replacement unique', email: 'replacement-unique@example.com' },
      ],
    });
    const { composeStore } = await storeWithIdentityDefaults([configured, replacement]);

    composeStore.open({
      to: [{ name: 'Manual recipient', email: 'duplicate@example.com' }],
      cc: [{ email: 'CC@example.com' }],
    });

    expect(composeStore.draft.bcc).toEqual([
      { name: 'Unique display', email: 'unique@example.com' },
    ]);
    composeStore.selectFromIndex(1);
    expect(composeStore.draft.bcc).toEqual([
      { name: 'Replacement unique', email: 'replacement-unique@example.com' },
    ]);
  });

  it('retains a suppressed Bcc slot across two no-op broadcasts and switch-back', async () => {
    const configured = identity({
      id: 1,
      remote_id: 'configured',
      email: 'me@example.com',
      bcc: [{ name: 'Archive', email: 'duplicate@example.com' }],
    });
    const unsigned = identity({
      id: 2,
      remote_id: 'unsigned',
      email: 'other@example.com',
    });
    const { composeStore, repo } = await storeWithIdentityDefaults([configured, unsigned]);
    const sessionId = composeStore.open({
      to: [{ name: 'Manual recipient', email: 'DUPLICATE@example.com' }],
    });
    const session = composeStore.sessionById(sessionId)!;
    expect(session.draft.bcc).toEqual([]);
    expect(session.automaticBccOrigins).toEqual([{
      slot: 0,
      address: { name: 'Archive', email: 'duplicate@example.com' },
      touched: true,
    }]);
    const suppressedOrigin = session.automaticBccOrigins[0];

    composeStore.open({ subject: 'Another composer' });
    repo.setIdentities([configured, unsigned]);
    await composeStore.refreshIdentities();
    await composeStore.refreshIdentities();
    expect(session.automaticBccOrigins[0]).toBe(suppressedOrigin);

    composeStore.setRecipientEntries('to', [], sessionId);
    composeStore.selectFromIndex(1, sessionId);
    composeStore.selectFromIndex(0, sessionId);
    expect(session.draft.bcc).toEqual([]);
  });

  it('does not recreate automatic Bcc provenance on a no-op refresh', async () => {
    const configured = defaultIdentity();
    const { composeStore, repo } = await storeWithIdentityDefaults([configured]);
    const sessionId = composeStore.open();
    const session = composeStore.sessionById(sessionId)!;
    const origins = session.automaticBccOrigins;

    composeStore.open({ subject: 'Another composer' });
    repo.setIdentities([configured]);
    await composeStore.refreshIdentities();

    expect(session.automaticBccOrigins).toBe(origins);
    expect(session.draft.bcc).toEqual([
      { name: 'Archive', email: 'archive@example.com' },
      { email: 'audit@example.com' },
    ]);
  });

  it('does not apply the Identity storage limit to the expanded compose body', async () => {
    const longSignature = 'x'.repeat(3_000);
    const { composeStore } = await storeWithIdentityDefaults([identity({
      id: 1,
      remote_id: 'long-signature',
      email: 'me@example.com',
      html_signature: `<p>${longSignature}</p>`,
      text_signature: longSignature,
    })]);

    composeStore.open();

    expect(composeStore.draft.htmlBody).toContain(longSignature);
    expect(composeStore.draft.textBody).toBe(longSignature);
  });

  it('places signatures before quoted content for reply, reply-all, and forward', async () => {
    const { composeStore } = await storeWithIdentityDefaults([defaultIdentity()]);
    const origins = [
      COMPOSE_OPEN_ORIGIN.REPLY,
      COMPOSE_OPEN_ORIGIN.REPLY_ALL,
      COMPOSE_OPEN_ORIGIN.FORWARD,
    ] as const;

    for (const origin of origins) {
      const sessionId = composeStore.open({
        htmlBody: '<div class="moz-cite-prefix">Quoted header</div>'
          + '<blockquote type="cite"><p>Quoted body</p></blockquote>',
        textBody: '\n\nQuoted header\n\n> Quoted body\n',
      }, { origin });
      const session = composeStore.sessionById(sessionId)!;
      expect(session.editorHtmlBody.indexOf('Kind regards'))
        .toBeLessThan(session.editorHtmlBody.indexOf('Quoted header'));
      expect(session.draft.textBody.indexOf('Kind regards'))
        .toBeLessThan(session.draft.textBody.indexOf('Quoted header'));
      expect(session.openOrigin).toBe(origin);
      expect(composeStore.isSessionDirty(sessionId)).toBe(false);
    }
  });

  it('replaces intact defaults while preserving surrounding text and manual Bcc', async () => {
    const first = defaultIdentity();
    const second = identity({
      id: 2,
      remote_id: 'second',
      email: 'other@example.com',
      bcc: [
        { name: 'New archive', email: 'new-archive@example.com' },
        { name: 'New audit', email: 'new-audit@example.com' },
      ],
      html_signature: '<p>Second signature</p>',
      text_signature: 'Second signature',
    });
    const { composeStore } = await storeWithIdentityDefaults([first, second]);
    const sessionId = composeStore.open();
    const session = composeStore.sessionById(sessionId)!;
    composeStore.setRecipientEntries('bcc', [
      ...composeStore.recipientEntries('bcc', sessionId),
      { name: 'Manual copy', email: 'manual@example.com' },
    ], sessionId);
    const editedOutside = session.editorHtmlBody
      .replace('<div><br></div>', '<p>Before signature</p>')
      .concat('<p>After signature</p>');
    composeStore.setBodyContent({
      html: editedOutside,
      text: 'Before signature\nKind regards,\nAndrei\nAfter signature',
    }, sessionId, { touch: false });

    composeStore.selectFromIndex(1, sessionId);

    expect(session.draft.bcc).toEqual([
      { name: 'New archive', email: 'new-archive@example.com' },
      { name: 'New audit', email: 'new-audit@example.com' },
      { name: 'Manual copy', email: 'manual@example.com' },
    ]);
    expect(session.draft.htmlBody).toContain('Before signature');
    expect(session.draft.htmlBody).toContain('Second signature');
    expect(session.draft.htmlBody).toContain('After signature');
    expect(session.draft.htmlBody).not.toContain('Kind regards');
    expect(session.draft.htmlBody).not.toContain('data-stormbox-');
  });

  it('keeps the configured text signature paired while HTML is edited outside it', async () => {
    const first = identity({
      id: 1,
      remote_id: 'first',
      email: 'me@example.com',
      html_signature: '<p>Rendered first</p>',
      text_signature: 'Plain first',
    });
    const second = identity({
      id: 2,
      remote_id: 'second',
      email: 'other@example.com',
      html_signature: '<p>Rendered second</p>',
      text_signature: 'Plain second',
    });
    const { composeStore } = await storeWithIdentityDefaults([first, second]);
    const sessionId = composeStore.open();
    const session = composeStore.sessionById(sessionId)!;
    composeStore.setBodyContent({
      html: session.editorHtmlBody.replace(
        '<div><br></div>',
        '<p>User-authored text</p>',
      ),
      text: 'User-authored text\nRendered first',
    }, sessionId, { touch: false });

    expect(session.draft.textBody).toContain('User-authored text');
    expect(session.draft.textBody).toContain('Plain first');
    expect(session.draft.textBody).not.toContain('Rendered first');

    composeStore.selectFromIndex(1, sessionId);

    expect(session.draft.textBody).toContain('User-authored text');
    expect(session.draft.textBody).toContain('Plain second');
    expect(session.draft.textBody).not.toContain('Plain first');
    expect(session.draft.htmlBody).toContain('Rendered second');
  });

  it('preserves the exact quoted text while replacing a paired signature', async () => {
    const first = identity({
      id: 1,
      remote_id: 'first',
      email: 'me@example.com',
      html_signature: '<p>Rendered first</p>',
      text_signature: 'Plain first',
    });
    const second = identity({
      id: 2,
      remote_id: 'second',
      email: 'other@example.com',
      html_signature: '<p>Rendered second</p>',
      text_signature: 'Plain second',
    });
    const { composeStore } = await storeWithIdentityDefaults([first, second]);
    const quotedText = '\n\nOn Tuesday, Alice wrote:\n> Exact quoted line\n';
    const sessionId = composeStore.open({
      htmlBody: '<div>On Tuesday, Alice wrote:</div><blockquote>Quoted line</blockquote>',
      textBody: quotedText,
    }, { origin: COMPOSE_OPEN_ORIGIN.REPLY });
    const session = composeStore.sessionById(sessionId)!;

    composeStore.selectFromIndex(1, sessionId);

    expect(session.draft.textBody).toBe(`Plain second${quotedText}`);
  });

  it('updates paired signature text when two identities share the same HTML', async () => {
    const sharedHtml = '<p>Shared rendered signature</p>';
    const { composeStore } = await storeWithIdentityDefaults([
      identity({
        id: 1,
        remote_id: 'first',
        email: 'me@example.com',
        html_signature: sharedHtml,
        text_signature: 'First text signature',
      }),
      identity({
        id: 2,
        remote_id: 'second',
        email: 'other@example.com',
        html_signature: sharedHtml,
        text_signature: 'Second text signature',
      }),
    ]);
    const sessionId = composeStore.open();
    const session = composeStore.sessionById(sessionId)!;

    composeStore.selectFromIndex(1, sessionId);

    expect(session.draft.textBody).toBe('Second text signature');
    expect(session.draft.htmlBody).toContain('Shared rendered signature');
  });

  it('preserves edited or removed automatic Bcc slots across a From change', async () => {
    const first = defaultIdentity();
    const second = identity({
      id: 2,
      remote_id: 'second',
      email: 'other@example.com',
      bcc: [
        { name: 'Replacement archive', email: 'replacement@example.com' },
        { name: 'Replacement audit', email: 'replacement-audit@example.com' },
      ],
    });
    const { composeStore } = await storeWithIdentityDefaults([first, second]);
    const sessionId = composeStore.open();
    composeStore.setRecipientEntries('bcc', [
      { name: 'Edited archive', email: 'archive@example.com' },
      { email: 'audit@example.com' },
      { email: 'manual@example.com' },
      { text: 'unfinished address', invalid: true },
    ], sessionId);

    composeStore.selectFromIndex(1, sessionId);

    expect(composeStore.recipientEntries('bcc', sessionId)).toEqual([
      { name: 'Edited archive', email: 'archive@example.com' },
      { name: 'Replacement audit', email: 'replacement-audit@example.com' },
      { email: 'manual@example.com' },
      { text: 'unfinished address', invalid: true },
    ]);

    const removedId = composeStore.open({ fromIdx: 0 });
    composeStore.setRecipientEntries('bcc', [], removedId);
    composeStore.selectFromIndex(1, removedId);
    expect(composeStore.recipientEntries('bcc', removedId)).toEqual([]);
  });

  it('keeps replacement defaults ordered after Bcc pills are reordered', async () => {
    const first = defaultIdentity();
    const second = identity({
      id: 2,
      remote_id: 'second',
      email: 'other@example.com',
      bcc: [
        { name: 'First replacement', email: 'first-replacement@example.com' },
        { name: 'Second replacement', email: 'second-replacement@example.com' },
      ],
    });
    const { composeStore } = await storeWithIdentityDefaults([first, second]);
    const sessionId = composeStore.open();
    composeStore.setRecipientEntries('bcc', [
      { email: 'audit@example.com' },
      { email: 'manual@example.com' },
      { name: 'Archive', email: 'archive@example.com' },
    ], sessionId);

    composeStore.selectFromIndex(1, sessionId);

    expect(composeStore.recipientEntries('bcc', sessionId)).toEqual([
      { name: 'First replacement', email: 'first-replacement@example.com' },
      { name: 'Second replacement', email: 'second-replacement@example.com' },
      { email: 'manual@example.com' },
    ]);
  });

  it('does not replace an edited or removed automatic signature', async () => {
    const first = defaultIdentity();
    const second = identity({
      id: 2,
      remote_id: 'second',
      email: 'other@example.com',
      html_signature: '<p>Second signature</p>',
      text_signature: 'Second signature',
    });
    const { composeStore } = await storeWithIdentityDefaults([first, second]);
    const editedId = composeStore.open();
    const edited = composeStore.sessionById(editedId)!;
    const editedHtml = edited.editorHtmlBody.replace('Kind regards', 'Personal sign-off');
    composeStore.updateTrackedOrigins([{
      id: 'identity-signature',
      present: true,
      touched: true,
    }], editedId);
    composeStore.setBodyContent({
      html: editedHtml,
      text: 'Personal sign-off,\nAndrei',
    }, editedId, { touch: false });

    composeStore.selectFromIndex(1, editedId);
    expect(edited.draft.htmlBody).toContain('Personal sign-off');
    expect(edited.draft.htmlBody).not.toContain('Second signature');

    const removedId = composeStore.open({ fromIdx: 0 });
    const removed = composeStore.sessionById(removedId)!;
    composeStore.setBodyContent({ html: '<p>User body</p>', text: 'User body' }, removedId, {
      touch: false,
    });
    composeStore.selectFromIndex(1, removedId);
    expect(removed.draft.htmlBody).toBe('<p>User body</p>');
  });

  it('adds a first signature after user text and before an intact quote', async () => {
    const first = identity({
      id: 1,
      remote_id: 'plain',
      email: 'me@example.com',
    });
    const second = identity({
      id: 2,
      remote_id: 'signed',
      email: 'signed@example.com',
      html_signature: '<p>Added signature</p>',
      text_signature: 'Added signature',
    });
    const { composeStore } = await storeWithIdentityDefaults([first, second]);
    const sessionId = composeStore.open({
      htmlBody: '<div class="moz-cite-prefix">Quoted header</div>'
        + '<blockquote type="cite">Quoted body</blockquote>',
      textBody: '\n\nQuoted header\n> Quoted body',
    }, { origin: COMPOSE_OPEN_ORIGIN.REPLY });
    const session = composeStore.sessionById(sessionId)!;
    composeStore.setBodyContent({
      html: session.editorHtmlBody.replace('<div><br></div>', '<p>User introduction</p>'),
      text: 'User introduction\n\nQuoted header\n> Quoted body',
    }, sessionId, { touch: false });

    composeStore.selectFromIndex(1, sessionId);

    const html = session.editorHtmlBody;
    expect(html.indexOf('User introduction')).toBeLessThan(html.indexOf('Added signature'));
    expect(html.indexOf('Added signature')).toBeLessThan(html.indexOf('Quoted header'));
  });

  it('preserves exact reply text when an identity arrives late', async () => {
    const { composeStore, repo } = await storeWithIdentityDefaults([]);
    const originalText = '\n\nOn Tuesday, Alice wrote:\n> Exact quote\n';
    const sessionId = composeStore.open({
      htmlBody: '<div>On Tuesday, Alice wrote:</div><blockquote>Exact quote</blockquote>',
      textBody: originalText,
    }, { origin: COMPOSE_OPEN_ORIGIN.REPLY });
    repo.setIdentities([identity({
      id: 1,
      remote_id: 'late',
      email: 'me@example.com',
      html_signature: '<p>Late rendered signature</p>',
      text_signature: 'Late text signature',
    })]);

    await composeStore.refreshIdentities();

    const session = composeStore.sessionById(sessionId)!;
    expect(session.draft.textBody).toBe(`Late text signature${originalText}`);
    expect(session.draft.htmlBody).toContain('Late rendered signature');
    expect(composeStore.isSessionDirty(sessionId)).toBe(false);
  });

  it('uses initial text splicing when switching from unsigned to signed', async () => {
    const unsigned = identity({
      id: 1,
      remote_id: 'unsigned',
      email: 'me@example.com',
    });
    const signed = identity({
      id: 2,
      remote_id: 'signed',
      email: 'other@example.com',
      html_signature: '<p>Rendered signature</p>',
      text_signature: 'Text signature',
    });
    const { composeStore } = await storeWithIdentityDefaults([unsigned, signed]);
    const originalText = '\n\nQuoted prefix\n> Exact quote\n';
    const sessionId = composeStore.open({
      htmlBody: '<div>Quoted prefix</div><blockquote>Exact quote</blockquote>',
      textBody: originalText,
    }, { origin: COMPOSE_OPEN_ORIGIN.REPLY });

    composeStore.selectFromIndex(1, sessionId);

    expect(composeStore.sessionById(sessionId)?.draft.textBody)
      .toBe(`Text signature${originalText}`);
  });

  it('never infers defaults for an explicitly reopened server draft', async () => {
    const second = identity({
      id: 2,
      remote_id: 'second',
      email: 'other@example.com',
      bcc: [{ name: 'Other archive', email: 'other-archive@example.com' }],
      html_signature: '<p>Other signature</p>',
      text_signature: 'Other signature',
    });
    const { composeStore } = await storeWithIdentityDefaults([defaultIdentity(), second]);
    const sessionId = composeStore.open({
      bcc: [
        { name: 'Archive', email: 'archive@example.com' },
        { email: 'audit@example.com' },
      ],
      htmlBody: '<p>Kind regards,<br><b>Andrei</b></p>',
      textBody: 'Kind regards,\nAndrei',
    }, { origin: COMPOSE_OPEN_ORIGIN.SERVER_DRAFT });
    const session = composeStore.sessionById(sessionId)!;

    expect(session.automaticBccOrigins).toEqual([]);
    expect(session.automaticSignatureOrigin).toBeNull();
    expect(session.editorHtmlBody).not.toContain('data-stormbox-');
    composeStore.selectFromIndex(1, sessionId);
    expect(session.draft.bcc).toEqual([
      { name: 'Archive', email: 'archive@example.com' },
      { email: 'audit@example.com' },
    ]);
    expect(session.draft.htmlBody).toContain('Kind regards');
    expect(session.draft.htmlBody).not.toContain('Other signature');
  });

  it('keeps provenance aligned when the selected identity refreshes and reorders', async () => {
    const first = defaultIdentity();
    const other = identity({
      id: 2,
      remote_id: 'other',
      email: 'other@example.com',
    });
    const { composeStore, repo } = await storeWithIdentityDefaults([first, other]);
    const sessionId = composeStore.open();
    repo.setIdentities([
      other,
      identity({
        ...first,
        bcc: [{ name: 'Refreshed archive', email: 'refreshed@example.com' }],
        html_signature: '<p>Refreshed signature</p>',
        text_signature: 'Refreshed signature',
      }),
    ]);

    await composeStore.refreshIdentities();

    const session = composeStore.sessionById(sessionId)!;
    expect(session.draft.fromIdx).toBe(1);
    expect(session.draft.bcc).toEqual([
      { name: 'Refreshed archive', email: 'refreshed@example.com' },
    ]);
    expect(session.draft.htmlBody).toContain('Refreshed signature');
    expect(composeStore.isSessionDirty(sessionId)).toBe(false);
  });

  it('does not reseed a Bcc removal made while identity refresh is in flight', async () => {
    const first = defaultIdentity();
    const { composeStore, repo } = await storeWithIdentityDefaults([first]);
    const sessionId = composeStore.open();
    let releaseRefresh: (identities: IdentityRow[]) => void = () => {};
    repo.listIdentities.mockImplementationOnce(
      () => new Promise((resolve) => { releaseRefresh = resolve; }),
    );

    const refreshing = composeStore.refreshIdentities();
    composeStore.setRecipientEntries('bcc', [], sessionId);
    releaseRefresh([identity({
      ...first,
      bcc: [{ name: 'Refreshed archive', email: 'refreshed@example.com' }],
    })]);
    await refreshing;

    expect(composeStore.sessionById(sessionId)?.draft.bcc).toEqual([]);
    expect(composeStore.isSessionDirty(sessionId)).toBe(true);
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

  it('does not treat an automatic Bcc as a user-selected recipient', async () => {
    const composeStore = await composerWithOutcome(
      {},
      undefined,
      [identity({
        id: 1,
        email: 'me@example.com',
        bcc: [{ name: 'Archive', email: 'archive@example.com' }],
      })],
    );
    composeStore.open({ subject: 'Automatic copy only' });

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.error).toBe('Add at least one recipient.');
    expect(lastRepo.insertPendingMutation).not.toHaveBeenCalled();
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
    expect(composeStore.error)
      .toBe('Fix invalid recipients before saving or sending this message.');
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
    expect(composeStore.error)
      .toBe('Fix invalid recipients before saving or sending this message.');
    expect(composeStore.draft.to).toEqual([]);
  });

  it('uses one actionable message for multiple unreadable fragments', async () => {
    const composeStore = await composerWithOutcome({});
    composeStore.open();
    composeStore.setRecipientEntries('to', [
      { text: 'first bad', invalid: true },
      { text: 'second@', invalid: true },
    ]);

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.error)
      .toBe('Fix invalid recipients before saving or sending this message.');
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
        reply_to: [{ name: 'Replies', email: 'replies@example.com' }],
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

describe('compose-store sessions and draft autosave', () => {
  async function autosaveStore(
    runMutationImpl?: (accountId: number, id: number) => Promise<any>,
    configuredIdentities: IdentityRow[] = [identity({
      id: 1,
      remote_id: 'identity-1',
      email: 'me@example.com',
    })],
  ) {
    let mutationId = 0;
    const repo = {
      subscribe: vi.fn(() => () => {}),
      getAccount: vi.fn(async () => ({ id: 1, primary_email: 'me@example.com' })),
      listIdentities: vi.fn(async () => configuredIdentities),
      ensureIdentities: vi.fn(async () => {}),
      insertPendingMutation: vi.fn(async (_input: any) => ({ id: ++mutationId })),
      findMessageByRfc822MessageId: vi.fn(async () => null),
      getMessageBodyForDisplay: vi.fn(async () => null),
      retryPendingDraftMutation: vi.fn(async () => ({ retried: 1 })),
      abandonPendingDraftMutation: vi.fn(async () => ({ abandoned: 1 })),
      runMutation: vi.fn(runMutationImpl ?? (async (_accountId: number, id: number) => ({
        attempted: 1,
        succeeded: 1,
        failed: 0,
        result: {
          draftSessionId: 'session',
          revision: id,
          emailId: `draft-${id}`,
          localMessageId: id,
          messageId: `<revision-${id}@example.com>`,
          payloadHash: `hash-${id}`,
        },
      }))),
    };
    __setRepositoryForTests(repo);
    const authStore = useAuthStore();
    authStore.accountId = 1;
    const mailStore = useMailStore();
    mailStore.folders = [{
      id: 10,
      account_id: 1,
      remote_id: 'mb-drafts',
      role: 'drafts',
      name: 'Drafts',
    } as any];
    const composeStore = useComposeStore();
    await composeStore.attach();
    await waitForAsyncWatchers();
    return { composeStore, repo };
  }

  it('keeps multiple sessions with exactly one expanded', () => {
    const composeStore = useComposeStore();
    const firstId = composeStore.open({ subject: 'First' });
    const secondId = composeStore.open({ subject: 'Second' });

    expect(composeStore.sessions).toHaveLength(2);
    expect(composeStore.sessionById(firstId)?.presentation)
      .toBe(COMPOSE_PRESENTATION.MINIMIZED);
    expect(composeStore.sessionById(secondId)?.presentation)
      .toBe(COMPOSE_PRESENTATION.EXPANDED);
    expect(composeStore.activeSessionId).toBe(secondId);

    expect(composeStore.restore(firstId)).toBe(true);
    expect(composeStore.sessionById(firstId)?.presentation)
      .toBe(COMPOSE_PRESENTATION.EXPANDED);
    expect(composeStore.sessionById(secondId)?.presentation)
      .toBe(COMPOSE_PRESENTATION.MINIMIZED);
  });

  it('refuses to minimize or replace a sending session', () => {
    const composeStore = useComposeStore();
    const sessionId = composeStore.open({ subject: 'Sending' });
    const session = composeStore.sessionById(sessionId)!;
    session.status = COMPOSE_STATE.SENDING;

    expect(composeStore.minimize(sessionId)).toBe(false);
    expect(composeStore.open({ subject: 'Other' })).toBe(sessionId);
    expect(composeStore.sessions).toHaveLength(1);
    expect(session.presentation).toBe(COMPOSE_PRESENTATION.EXPANDED);
  });

  it('computes dirty state relative to the initialized seed', () => {
    const composeStore = useComposeStore();
    const sessionId = composeStore.open({ subject: 'Seed' });
    const session = composeStore.sessionById(sessionId)!;

    expect(composeStore.isSessionDirty(sessionId)).toBe(false);
    session.draft.subject = 'Changed';
    expect(composeStore.isSessionDirty(sessionId)).toBe(true);
    session.draft.subject = 'Seed';
    expect(composeStore.isSessionDirty(sessionId)).toBe(false);
  });

  it('keeps a server draft Reply-To through From changes, save, and send', async () => {
    const customReplyTo = [{ name: 'Draft replies', email: 'draft-replies@example.com' }];
    const { composeStore, repo } = await autosaveStore(undefined, [
      identity({
        id: 1,
        remote_id: 'first',
        email: 'first@example.com',
        reply_to: [{ name: 'First replies', email: 'first-replies@example.com' }],
      }),
      identity({
        id: 2,
        remote_id: 'second',
        email: 'second@example.com',
        reply_to: [{ name: 'Second replies', email: 'second-replies@example.com' }],
      }),
    ]);
    const sessionId = composeStore.open({
      to: [{ email: 'recipient@example.com' }],
      subject: 'Stored draft',
      replyTo: customReplyTo,
    }, { origin: COMPOSE_OPEN_ORIGIN.SERVER_DRAFT });
    const session = composeStore.sessionById(sessionId)!;
    composeStore.selectFromIndex(1, sessionId);
    expect(session.draft.replyTo).toEqual(customReplyTo);
    session.draft.replyTo = [{ email: 'changed-draft-replies@example.com' }];
    expect(composeStore.isSessionDirty(sessionId)).toBe(true);
    session.draft.replyTo = customReplyTo;

    await composeStore.saveDraft(sessionId, { explicit: true });
    const saveInput = repo.insertPendingMutation.mock.calls
      .map(([input]) => input)
      .find((input) => input.mutationType === MUTATION_TYPE.SAVE_DRAFT);
    expect(JSON.parse(saveInput.requestJson).replyTo).toEqual(customReplyTo);

    await composeStore.send(sessionId);
    const sendInput = repo.insertPendingMutation.mock.calls
      .map(([input]) => input)
      .find((input) => input.mutationType === MUTATION_TYPE.SEND);
    expect(JSON.parse(sendInput.requestJson).replyTo).toEqual(customReplyTo);
  });

  it('does not add Identity Reply-To to a server draft that stored none', async () => {
    const { composeStore, repo } = await autosaveStore(undefined, [identity({
      id: 1,
      remote_id: 'identity',
      email: 'sender@example.com',
      reply_to: [{ name: 'Identity replies', email: 'identity-replies@example.com' }],
    })]);
    const sessionId = composeStore.open({
      to: [{ email: 'recipient@example.com' }],
      subject: 'No Reply-To draft',
      replyTo: [],
    }, { origin: COMPOSE_OPEN_ORIGIN.SERVER_DRAFT });

    await composeStore.send(sessionId);

    const input = repo.insertPendingMutation.mock.calls
      .map(([queued]) => queued)
      .find((queued) => queued.mutationType === MUTATION_TYPE.SEND);
    expect(JSON.parse(input.requestJson).replyTo).toEqual([]);
  });

  it('treats Squire trailing newlines as the initialized text body', () => {
    const composeStore = useComposeStore();
    const emptyId = composeStore.open();
    composeStore.sessionById(emptyId)!.draft.textBody = '\n';
    expect(composeStore.isSessionDirty(emptyId)).toBe(false);

    const quotedId = composeStore.open({ textBody: 'Quoted body' });
    composeStore.sessionById(quotedId)!.draft.textBody = 'Quoted body\r\n';
    expect(composeStore.isSessionDirty(quotedId)).toBe(false);
  });

  it('does not consider a default From identity meaningful content', async () => {
    const { composeStore } = await autosaveStore();
    const sessionId = composeStore.open();

    expect(composeStore.isSessionMeaningfullyNonEmpty(sessionId)).toBe(false);
    composeStore.sessionById(sessionId)!.draft.subject = ' ';
    expect(composeStore.isSessionMeaningfullyNonEmpty(sessionId)).toBe(false);
  });

  it('autosaves two seconds after a semantic edit and not before', async () => {
    vi.useFakeTimers();
    try {
      const { composeStore, repo } = await autosaveStore();
      const sessionId = composeStore.open();
      composeStore.sessionById(sessionId)!.draft.subject = 'Autosave me';
      composeStore.touchSession(sessionId);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(repo.insertPendingMutation).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await waitForAsyncWatchers();

      expect(repo.insertPendingMutation).toHaveBeenCalledTimes(1);
      expect(repo.insertPendingMutation.mock.calls[0][0].mutationType)
        .toBe(MUTATION_TYPE.SAVE_DRAFT);
      expect(composeStore.sessionById(sessionId)?.confirmedRevision?.emailId)
        .toBe('draft-1');
      expect(composeStore.isSessionDirty(sessionId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never autosaves an empty new session', async () => {
    vi.useFakeTimers();
    try {
      const { composeStore, repo } = await autosaveStore();
      const sessionId = composeStore.open();
      composeStore.touchSession(sessionId);

      await vi.advanceTimersByTimeAsync(35_000);

      expect(repo.insertPendingMutation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('autosaves at the thirty-second ceiling during continuous editing', async () => {
    vi.useFakeTimers();
    try {
      const { composeStore, repo } = await autosaveStore();
      const sessionId = composeStore.open();
      const session = composeStore.sessionById(sessionId)!;
      session.draft.subject = 'Edit 0';
      composeStore.touchSession(sessionId);

      for (let second = 1; second < 30; second += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
        session.draft.subject = `Edit ${second}`;
        composeStore.touchSession(sessionId);
      }
      expect(repo.insertPendingMutation).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await waitForAsyncWatchers();
      expect(repo.insertPendingMutation).toHaveBeenCalledTimes(1);
      expect(JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson).subject)
        .toBe('Edit 29');
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces edits during a save into one latest follow-up', async () => {
    vi.useFakeTimers();
    try {
      let releaseFirst: (result: any) => void = () => {};
      let calls = 0;
      const { composeStore, repo } = await autosaveStore(async (_accountId, id) => {
        calls += 1;
        if (calls === 1) {
          return new Promise((resolve) => { releaseFirst = resolve; });
        }
        return {
          attempted: 1,
          succeeded: 1,
          failed: 0,
          result: {
            revision: 2,
            emailId: 'draft-2',
            localMessageId: 2,
            messageId: '<revision-2@example.com>',
            payloadHash: 'hash-2',
          },
        };
      });
      const sessionId = composeStore.open();
      const session = composeStore.sessionById(sessionId)!;
      session.draft.subject = 'First payload';
      composeStore.touchSession(sessionId);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(repo.runMutation).toHaveBeenCalledTimes(1);

      session.draft.subject = 'Latest payload';
      composeStore.touchSession(sessionId);
      releaseFirst({
        attempted: 1,
        succeeded: 1,
        failed: 0,
        result: {
          revision: 1,
          emailId: 'draft-1',
          localMessageId: 1,
          messageId: '<revision-1@example.com>',
          payloadHash: 'hash-1',
        },
      });
      await waitForAsyncWatchers();
      await waitForAsyncWatchers();

      expect(repo.runMutation).toHaveBeenCalledTimes(2);
      expect(JSON.parse(repo.insertPendingMutation.mock.calls[1][0].requestJson).subject)
        .toBe('Latest payload');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps recipient and body edits made while an automatic save is in flight', async () => {
    vi.useFakeTimers();
    try {
      let releaseFirst: (result: any) => void = () => {};
      let calls = 0;
      const configuredIdentity = identity({
        id: 1,
        remote_id: 'identity-1',
        email: 'me@example.com',
        bcc: [{ name: 'Archive', email: 'archive@example.com' }],
        html_signature: '<p>Automatic signature</p>',
        text_signature: 'Automatic signature',
      });
      const { composeStore, repo } = await autosaveStore(async (_accountId, id) => {
        calls += 1;
        if (calls === 1) {
          return new Promise((resolve) => { releaseFirst = resolve; });
        }
        return {
          attempted: 1,
          succeeded: 1,
          failed: 0,
          result: {
            revision: id,
            emailId: `draft-${id}`,
            localMessageId: id,
            messageId: `<revision-${id}@example.com>`,
            payloadHash: `hash-${id}`,
          },
        };
      }, [configuredIdentity]);
      const sessionId = composeStore.open();
      const session = composeStore.sessionById(sessionId)!;
      session.draft.subject = 'First payload';
      composeStore.touchSession(sessionId);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(repo.runMutation).toHaveBeenCalledTimes(1);

      composeStore.setRecipientEntries('bcc', [
        ...composeStore.recipientEntries('bcc', sessionId),
        { name: 'Manual copy', email: 'manual@example.com' },
      ], sessionId);
      composeStore.setBodyContent({
        html: session.editorHtmlBody.replace('<div><br></div>', '<p>Latest body</p>'),
        text: 'Latest body\nAutomatic signature',
      }, sessionId);
      releaseFirst({
        attempted: 1,
        succeeded: 1,
        failed: 0,
        result: {
          revision: 1,
          emailId: 'draft-1',
          localMessageId: 1,
          messageId: '<revision-1@example.com>',
          payloadHash: 'hash-1',
        },
      });
      await waitForAsyncWatchers();
      await waitForAsyncWatchers();

      expect(repo.runMutation).toHaveBeenCalledTimes(2);
      const latest = JSON.parse(repo.insertPendingMutation.mock.calls[1][0].requestJson);
      expect(latest.bcc).toEqual([
        { name: 'Archive', email: 'archive@example.com' },
        { name: 'Manual copy', email: 'manual@example.com' },
      ]);
      expect(latest.htmlBody).toContain('Latest body');
      expect(latest.htmlBody).toContain('Automatic signature');
      expect(latest.htmlBody).not.toContain('data-stormbox-');
      expect(composeStore.isSessionDirty(sessionId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues marker-free signature HTML for send without changing data images', async () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const configuredIdentity = identity({
      id: 1,
      remote_id: 'identity-1',
      email: 'me@example.com',
      html_signature: `<p>Image signature<img src="${dataUrl}"></p>`,
      text_signature: 'Image signature',
    });
    const { composeStore, repo } = await autosaveStore(async () => ({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      result: { submitted: true, filed: true },
    }), [configuredIdentity]);
    const sessionId = composeStore.open({ to: [{ email: 'recipient@example.com' }] });

    await expect(composeStore.send(sessionId)).resolves.toBe(true);

    const request = JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson);
    expect(request.htmlBody).toContain(dataUrl);
    expect(request.htmlBody).toContain('Image signature');
    expect(request.htmlBody).not.toContain('data-stormbox-');
  });

  it('opens the close prompt only for dirty content', async () => {
    const composeStore = useComposeStore();
    const cleanId = composeStore.open();
    expect(composeStore.requestClose(cleanId)).toBe(true);

    const dirtyId = composeStore.open();
    composeStore.sessionById(dirtyId)!.draft.subject = 'Unsaved';
    expect(composeStore.requestClose(dirtyId)).toBe(false);
    expect(composeStore.sessionById(dirtyId)?.closePromptOpen).toBe(true);

    composeStore.cancelClose(dirtyId);
    expect(composeStore.sessionById(dirtyId)?.closePromptOpen).toBe(false);
    await expect(composeStore.closeWithoutSaving(dirtyId)).resolves.toBe(true);
  });

  it('explicitly saves a meaningful seed-clean prefill before closing', async () => {
    const { composeStore, repo } = await autosaveStore();
    const sessionId = composeStore.open({
      subject: 'Prefilled forward',
      textBody: 'Quoted body',
    });
    expect(composeStore.isSessionDirty(sessionId)).toBe(false);

    await expect(composeStore.saveAndClose(sessionId)).resolves.toBe(true);

    expect(repo.insertPendingMutation).toHaveBeenCalledTimes(1);
    expect(repo.insertPendingMutation.mock.calls[0][0].mutationType)
      .toBe(MUTATION_TYPE.SAVE_DRAFT);
    expect(composeStore.sessionById(sessionId)).toBeNull();
  });

  it('ignores injected provenance in equality and strips it from a draft request', async () => {
    const { composeStore, repo } = await autosaveStore();
    const sessionId = composeStore.open({
      htmlBody: '<p>Durable body</p>',
      textBody: 'Durable body',
    });
    const session = composeStore.sessionById(sessionId)!;
    session.draft.htmlBody = '<div data-stormbox-origin="injected" '
      + 'data-stormbox-extra="value"><p>Durable body</p></div>';

    expect(composeStore.isSessionDirty(sessionId)).toBe(false);
    await expect(composeStore.saveDraft(sessionId, { explicit: true })).resolves.toBe(true);

    const request = JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson);
    expect(request.htmlBody).toContain('Durable body');
    expect(request.htmlBody).not.toContain('data-stormbox-');
  });

  it('saves the message while omitting invalid recipient pills', async () => {
    const { composeStore, repo } = await autosaveStore();
    const sessionId = composeStore.open({
      subject: 'Keep this subject',
      textBody: 'Keep this body',
    });
    composeStore.setRecipientEntries('to', [
      { email: 'valid@example.com' },
      { text: 'unfinished recipient', invalid: true },
    ], sessionId);

    await expect(composeStore.saveDraft(sessionId, { explicit: true })).resolves.toBe(true);

    const request = JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson);
    expect(request).toMatchObject({
      to: [{ email: 'valid@example.com' }],
      subject: 'Keep this subject',
      textBody: 'Keep this body',
    });
    expect(composeStore.sessionById(sessionId)?.saveError)
      .toBe('Fix invalid recipients before saving or sending this message.');
    expect(composeStore.sessionById(sessionId)?.error).toBeNull();

    composeStore.setRecipientEntries('to', [{ email: 'fixed@example.com' }], sessionId);
    expect(composeStore.sessionById(sessionId)?.saveError).toBeNull();
  });

  it('deduplicates pending recipients across To, Cc, and Bcc before saving', async () => {
    const { composeStore, repo } = await autosaveStore();
    const sessionId = composeStore.open({ subject: 'Recipient union' });
    composeStore.setRecipientEntries('to', [
      { name: 'Alice', email: 'alice@example.com' },
    ], sessionId);
    composeStore.setPendingRecipientText(
      'cc',
      'Alice again <ALICE@example.com>, Bob <bob@example.com>',
      sessionId,
    );
    composeStore.setPendingRecipientText(
      'bcc',
      'Bob again <BOB@example.com>, Carol <carol@example.com>',
      sessionId,
    );

    await expect(composeStore.saveDraft(sessionId, { explicit: true })).resolves.toBe(true);

    const request = JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson);
    expect(request.to).toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
    expect(request.cc).toEqual([{ name: 'Bob', email: 'bob@example.com' }]);
    expect(request.bcc).toEqual([{ name: 'Carol', email: 'carol@example.com' }]);
  });

  it('recovers the confirmed revision when auto-drain retired the row first', async () => {
    const { composeStore, repo } = await autosaveStore(async () => ({
      attempted: 0,
      succeeded: 1,
      failed: 0,
    }));
    repo.findMessageByRfc822MessageId.mockResolvedValue({
      id: 91,
      remote_id: 'auto-drained-draft',
    });
    repo.getMessageBodyForDisplay.mockResolvedValue({ attachments: [] });
    const sessionId = composeStore.open({ subject: 'Save despite race' });

    await expect(composeStore.saveDraft(sessionId, { explicit: true })).resolves.toBe(true);

    expect(repo.findMessageByRfc822MessageId).toHaveBeenCalled();
    expect(composeStore.sessionById(sessionId)?.confirmedRevision).toMatchObject({
      emailId: 'auto-drained-draft',
      localMessageId: 91,
    });
  });

  it('retries the original durable mutation after an automatic save stops', async () => {
    let attempt = 0;
    const { composeStore, repo } = await autosaveStore(async () => {
      attempt += 1;
      if (attempt === 1) {
        return { attempted: 1, succeeded: 0, failed: 1 };
      }
      return {
        attempted: 1,
        succeeded: 1,
        failed: 0,
        result: {
          revision: 1,
          emailId: 'recovered-draft',
          localMessageId: 44,
          messageId: '<retry@example.com>',
          payloadHash: 'retry-hash',
        },
      };
    });
    const sessionId = composeStore.open({ subject: 'Retry this save' });

    await expect(composeStore.saveDraft(sessionId, { explicit: true })).resolves.toBe(false);
    expect(composeStore.sessionById(sessionId)?.isSaving).toBe(false);
    await expect(composeStore.saveDraft(sessionId, { explicit: true })).resolves.toBe(true);

    expect(repo.insertPendingMutation).toHaveBeenCalledTimes(1);
    expect(repo.retryPendingDraftMutation).toHaveBeenCalledWith(1, 1);
    expect(composeStore.sessionById(sessionId)?.confirmedRevision?.emailId)
      .toBe('recovered-draft');
  });

  it('carries reopened attachments into the final send mutation', async () => {
    const { composeStore, repo } = await autosaveStore();
    const sessionId = composeStore.open({
      to: [{ email: 'recipient@example.com' }],
      subject: 'Attachment send',
      attachments: [{
        part_id: 'a1',
        blob_id: 'current-part-blob',
        name: 'report.pdf',
        mime_type: 'application/pdf',
        size: 123,
        disposition: 'attachment',
        cid: null,
        charset: null,
      }],
    });

    await composeStore.send(sessionId);

    const queued = JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson);
    expect(queued.attachments).toEqual([
      expect.objectContaining({ blob_id: 'current-part-blob', name: 'report.pdf' }),
    ]);
  });

  it('installs refreshed attachment handles without creating save churn', async () => {
    const { composeStore, repo } = await autosaveStore(async () => ({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      result: {
        revision: 1,
        emailId: 'draft-with-new-parts',
        localMessageId: 55,
        messageId: '<parts@example.com>',
        payloadHash: 'parts-hash',
        attachments: [{
          part_id: 'a1',
          blob_id: 'refreshed-part-blob',
          name: 'report.pdf',
          mime_type: 'application/pdf',
          size: 123,
          disposition: 'attachment',
          cid: null,
          charset: null,
        }],
      },
    }));
    const sessionId = composeStore.open({
      subject: 'Attachment draft',
      attachments: [{
        part_id: 'old',
        blob_id: 'predecessor-part-blob',
        name: 'report.pdf',
        mime_type: 'application/pdf',
        size: 123,
        disposition: 'attachment',
        cid: null,
        charset: null,
      }],
    });

    await expect(composeStore.saveDraft(sessionId, { explicit: true })).resolves.toBe(true);

    expect(composeStore.sessionById(sessionId)?.attachments[0]?.canonicalBlobId)
      .toBe('refreshed-part-blob');
    expect(composeStore.isSessionDirty(sessionId)).toBe(false);
    expect(repo.insertPendingMutation).toHaveBeenCalledTimes(1);
  });

  it('reopens a server draft as a clean edit-safe compose session', async () => {
    const repo = {
      subscribe: vi.fn(() => () => {}),
      getAccount: vi.fn(async () => ({ id: 1, primary_email: 'me@example.com' })),
      listIdentities: vi.fn(async () => [identity({
        id: 1,
        remote_id: 'identity-1',
        email: 'me@example.com',
        bcc: [{ name: 'Archive', email: 'archive@example.com' }],
        html_signature: '<p>Must not be added</p>',
        text_signature: 'Must not be added',
      })]),
      ensureIdentities: vi.fn(async () => {}),
      isEmailClaimedBySend: vi.fn(async () => false),
      listMessageAddresses: vi.fn(async () => [
        { kind: 'from', position: 0, name: 'Me', email: 'me@example.com' },
        { kind: 'to', position: 0, name: 'Alice', email: 'alice@example.com' },
        { kind: 'cc', position: 0, name: null, email: 'cc@example.com' },
        { kind: 'replyTo', position: 0, name: 'Draft replies', email: 'draft@example.com' },
      ]),
      downloadBlob: vi.fn(async () => ({ type: 'image/png', base64: 'iVBORw0KGgo=' })),
    };
    __setRepositoryForTests(repo);
    const authStore = useAuthStore();
    authStore.accountId = 1;
    const composeStore = useComposeStore();
    await composeStore.attach();
    await waitForAsyncWatchers();

    const sessionId = await composeStore.prepareDraftFromMessage({
      ...sourceMessage({
        id: 77,
        remote_id: 'remote-draft',
        is_draft: 1,
        rfc822_message_id: 'draft-message@example.com',
      }),
      account_id: 1,
    }, {
      text: 'Draft text',
      html: '<style>body{position:fixed}</style>'
        + '<p id="cover" style="position:fixed;color:red" onclick="steal()">'
        + 'Draft<img src="cid:image-1"></p><script>steal()</script>',
      attachments: [{
        part_id: 'image',
        blob_id: 'part-blob',
        name: 'image.png',
        mime_type: 'image/png',
        size: 12,
        disposition: 'inline',
        cid: 'image-1',
        charset: null,
      }],
    });

    const session = composeStore.sessionById(sessionId);
    expect(session?.draft.to).toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
    expect(session?.draft.cc).toEqual([{ email: 'cc@example.com' }]);
    expect(session?.draft.bcc).toEqual([]);
    expect(session?.draft.replyTo).toEqual([
      { name: 'Draft replies', email: 'draft@example.com' },
    ]);
    expect(session?.draft.htmlBody).toContain('data:image/png;base64,');
    expect(session?.draft.htmlBody).toContain('color: red');
    expect(session?.draft.htmlBody).not.toContain('Must not be added');
    expect(session?.automaticBccOrigins).toEqual([]);
    expect(session?.automaticSignatureOrigin).toBeNull();
    expect(session?.draft.htmlBody).not.toMatch(/script|onclick|position|id="cover"/i);
    expect(session?.attachments).toEqual([]);
    expect(session?.confirmedRevision?.emailId).toBe('remote-draft');
    expect(composeStore.isSessionDirty(sessionId)).toBe(false);

    repo.listIdentities.mockResolvedValueOnce([identity({
      id: 1,
      remote_id: 'identity-1',
      email: 'me@example.com',
      bcc: [{ name: 'Refreshed archive', email: 'refreshed-archive@example.com' }],
      html_signature: '<p>Refreshed default</p>',
      text_signature: 'Refreshed default',
    })]);
    await composeStore.refreshIdentities();
    expect(session?.draft.bcc).toEqual([]);
    expect(session?.draft.htmlBody).not.toContain('Refreshed default');
  });

  it('downloads a complete body before opening a truncated draft for editing', async () => {
    const repo = {
      subscribe: vi.fn(() => () => {}),
      getAccount: vi.fn(async () => ({ id: 1, primary_email: 'me@example.com' })),
      listIdentities: vi.fn(async () => [identity({ id: 1, email: 'me@example.com' })]),
      ensureIdentities: vi.fn(async () => {}),
      isEmailClaimedBySend: vi.fn(async () => false),
      listMessageAddresses: vi.fn(async () => [
        { kind: 'from', position: 0, name: null, email: 'me@example.com' },
      ]),
      downloadBlob: vi.fn(async () => ({
        type: 'text/plain',
        base64: btoa('The complete draft body'),
      })),
    };
    __setRepositoryForTests(repo);
    const authStore = useAuthStore();
    authStore.accountId = 1;
    const composeStore = useComposeStore();
    await composeStore.attach();
    await waitForAsyncWatchers();

    const sessionId = await composeStore.prepareDraftFromMessage({
      ...sourceMessage({ id: 90, remote_id: 'large-draft', is_draft: 1 }),
      account_id: 1,
    }, {
      text: 'The complete',
      isComplete: false,
      truncatedParts: [{
        kind: 'text',
        blob_id: 'full-text-part',
        mime_type: 'text/plain',
      }],
    });

    expect(sessionId).toBeTruthy();
    expect(composeStore.sessionById(sessionId)?.draft.textBody)
      .toBe('The complete draft body');
  });

  it('refuses to replace a multi-part body it cannot reproduce losslessly', async () => {
    const repo = {
      subscribe: vi.fn(() => () => {}),
      getAccount: vi.fn(async () => ({ id: 1, primary_email: 'me@example.com' })),
      listIdentities: vi.fn(async () => [identity({ id: 1, email: 'me@example.com' })]),
      ensureIdentities: vi.fn(async () => {}),
      isEmailClaimedBySend: vi.fn(async () => false),
      listMessageAddresses: vi.fn(async () => []),
    };
    __setRepositoryForTests(repo);
    const authStore = useAuthStore();
    authStore.accountId = 1;
    const composeStore = useComposeStore();
    await composeStore.attach();
    await waitForAsyncWatchers();

    const opened = await composeStore.prepareDraftFromMessage({
      ...sourceMessage({ id: 93, remote_id: 'multipart-draft', is_draft: 1 }),
      account_id: 1,
    }, {
      text: 'first',
      bodyParts: [
        {
          kind: 'text',
          value: 'first',
          isTruncated: false,
          blob_id: 'one',
          mime_type: 'text/plain',
          charset: 'utf-8',
        },
        {
          kind: 'text',
          value: 'second',
          isTruncated: false,
          blob_id: 'two',
          mime_type: 'text/plain',
          charset: 'utf-8',
        },
      ],
    });

    expect(opened).toBeNull();
    expect(composeStore.sessions).toHaveLength(0);
    expect(composeStore.notice).toMatch(/could not be loaded completely/i);
  });

  it('drops a stale draft reopen after another compose gesture wins', async () => {
    let releaseAddresses: (rows: any[]) => void = () => {};
    const repo = {
      subscribe: vi.fn(() => () => {}),
      getAccount: vi.fn(async () => ({ id: 1, primary_email: 'me@example.com' })),
      listIdentities: vi.fn(async () => [identity({ id: 1, email: 'me@example.com' })]),
      ensureIdentities: vi.fn(async () => {}),
      isEmailClaimedBySend: vi.fn(async () => false),
      listMessageAddresses: vi.fn(() =>
        new Promise<any[]>((resolve) => { releaseAddresses = resolve; })),
    };
    __setRepositoryForTests(repo);
    const authStore = useAuthStore();
    authStore.accountId = 1;
    const composeStore = useComposeStore();
    await composeStore.attach();
    await waitForAsyncWatchers();

    const stale = composeStore.prepareDraftFromMessage({
      ...sourceMessage({ id: 91, remote_id: 'stale-draft', is_draft: 1 }),
      account_id: 1,
    }, { text: 'Stale' });
    await waitForAsyncWatchers();
    const wantedId = composeStore.open({ subject: 'The compose the user wanted' });
    releaseAddresses([]);

    await expect(stale).resolves.toBeNull();
    expect(composeStore.activeSessionId).toBe(wantedId);
    expect(composeStore.draft.subject).toBe('The compose the user wanted');
  });

  it('requires an explicit identity choice for an unavailable draft sender', async () => {
    const repo = {
      subscribe: vi.fn(() => () => {}),
      getAccount: vi.fn(async () => ({ id: 1, primary_email: 'me@example.com' })),
      listIdentities: vi.fn(async () => [identity({ id: 1, email: 'me@example.com' })]),
      ensureIdentities: vi.fn(async () => {}),
      isEmailClaimedBySend: vi.fn(async () => false),
      listMessageAddresses: vi.fn(async () => [
        { kind: 'from', position: 0, name: 'Old alias', email: 'gone@example.com' },
      ]),
    };
    __setRepositoryForTests(repo);
    const authStore = useAuthStore();
    authStore.accountId = 1;
    const composeStore = useComposeStore();
    await composeStore.attach();
    await waitForAsyncWatchers();

    const sessionId = await composeStore.prepareDraftFromMessage({
      ...sourceMessage({ id: 92, remote_id: 'alias-draft', is_draft: 1 }),
      account_id: 1,
    }, { text: 'Alias draft' });

    expect(composeStore.sessionById(sessionId)?.unresolvedFrom?.email)
      .toBe('gone@example.com');
    composeStore.sessionById(sessionId)!.draft.subject = 'Edited alias draft';
    await expect(composeStore.saveDraft(sessionId, { explicit: true })).resolves.toBe(false);
    expect(composeStore.sessionById(sessionId)?.saveError).toMatch(/From identity/i);
  });

  it('does not open a draft claimed by an unresolved send', async () => {
    const repo = {
      subscribe: vi.fn(() => () => {}),
      getAccount: vi.fn(async () => ({ id: 1, primary_email: 'me@example.com' })),
      listIdentities: vi.fn(async () => [identity({ id: 1, email: 'me@example.com' })]),
      ensureIdentities: vi.fn(async () => {}),
      isEmailClaimedBySend: vi.fn(async () => true),
      listMessageAddresses: vi.fn(async () => []),
    };
    __setRepositoryForTests(repo);
    const authStore = useAuthStore();
    authStore.accountId = 1;
    const composeStore = useComposeStore();
    await composeStore.attach();
    await waitForAsyncWatchers();

    const opened = await composeStore.prepareDraftFromMessage({
      ...sourceMessage({ id: 88, remote_id: 'send-draft', is_draft: 1 }),
      account_id: 1,
    }, {});

    expect(opened).toBeNull();
    expect(composeStore.sessions).toHaveLength(0);
    expect(composeStore.notice).toMatch(/send whose outcome/i);
  });

  it('waits for autosave and carries its exact draft id into send cleanup', async () => {
    vi.useFakeTimers();
    try {
      let releaseSave: (result: any) => void = () => {};
      const { composeStore, repo } = await autosaveStore(async (_accountId, id) => {
        if (id === 1) return new Promise((resolve) => { releaseSave = resolve; });
        return {
          attempted: 1,
          succeeded: 1,
          failed: 0,
          result: { submitted: true, filed: true },
        };
      });
      const sessionId = composeStore.open({ to: [{ email: 'recipient@example.com' }] });
      const session = composeStore.sessionById(sessionId)!;
      session.draft.subject = 'Save before send';
      composeStore.touchSession(sessionId);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(repo.insertPendingMutation).toHaveBeenCalledTimes(1);

      const sending = composeStore.send(sessionId);
      await waitForAsyncWatchers();
      expect(repo.insertPendingMutation).toHaveBeenCalledTimes(1);
      releaseSave({
        attempted: 1,
        succeeded: 1,
        failed: 0,
        result: {
          revision: 1,
          emailId: 'saved-draft',
          localMessageId: 14,
          messageId: '<saved@example.com>',
          payloadHash: 'saved-hash',
        },
      });
      await expect(sending).resolves.toBe(true);

      expect(repo.insertPendingMutation).toHaveBeenCalledTimes(2);
      const sendInput = repo.insertPendingMutation.mock.calls[1][0];
      expect(sendInput.mutationType).toBe(MUTATION_TYPE.SEND);
      expect(JSON.parse(sendInput.requestJson).draftEmailIds).toEqual(['saved-draft']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('permanently destroys the confirmed revision when Discard is chosen', async () => {
    const { composeStore, repo } = await autosaveStore();
    const sessionId = composeStore.open({ subject: 'Saved draft' });
    const session = composeStore.sessionById(sessionId)!;
    session.confirmedRevision = {
      emailId: 'draft-to-destroy',
      localMessageId: 23,
      revision: 1,
      messageId: '<draft@example.com>',
      payloadHash: 'hash',
    };

    await expect(composeStore.discardDraft(sessionId)).resolves.toBe(true);

    const input = repo.insertPendingMutation.mock.calls[0][0];
    expect(input.mutationType).toBe(MUTATION_TYPE.DISCARD_DRAFT);
    expect(JSON.parse(input.requestJson).draftEmailIds).toEqual(['draft-to-destroy']);
    expect(composeStore.sessionById(sessionId)).toBeNull();
  });

  it("refuses Don't Save while a discard-all obligation remains unresolved", async () => {
    const { composeStore, repo } = await autosaveStore(async () => ({
      attempted: 1,
      succeeded: 0,
      failed: 1,
    }));
    const sessionId = composeStore.open({ subject: 'Saved draft' });
    const session = composeStore.sessionById(sessionId)!;
    session.confirmedRevision = {
      emailId: 'draft-to-preserve',
      localMessageId: 23,
      revision: 1,
      messageId: '<draft@example.com>',
      payloadHash: 'hash',
    };

    await expect(composeStore.discardDraft(sessionId)).resolves.toBe(false);
    await expect(composeStore.closeWithoutSaving(sessionId)).resolves.toBe(false);

    expect(session.pendingDiscardMutationId).toBe(1);
    expect(session.pendingDiscardIntent).toBe('discard-all');
    expect(composeStore.sessionById(sessionId)).toBe(session);
    expect(repo.abandonPendingDraftMutation).not.toHaveBeenCalled();
  });

  it('abandons a failed replacement without scheduling its confirmed predecessor', async () => {
    const { composeStore, repo } = await autosaveStore(async () => ({
      attempted: 1,
      succeeded: 0,
      failed: 1,
    }));
    repo.abandonPendingDraftMutation.mockResolvedValue({
      abandoned: 0,
      converted: 1,
      parked: 0,
      inFlight: 0,
      mutationId: 1,
    } as any);
    const sessionId = composeStore.open({ subject: 'Saved version' });
    const session = composeStore.sessionById(sessionId)!;
    session.confirmedRevision = {
      emailId: 'confirmed-draft',
      localMessageId: 23,
      revision: 1,
      messageId: '<confirmed@example.com>',
      payloadHash: 'confirmed-hash',
    };
    session.draft.subject = 'Failed replacement';

    await expect(composeStore.saveDraft(sessionId, { explicit: true })).resolves.toBe(false);
    await expect(composeStore.closeWithoutSaving(sessionId)).resolves.toBe(true);

    expect(repo.abandonPendingDraftMutation).toHaveBeenCalledWith(1, 1, {
      intent: 'keep-confirmed',
      confirmedEmailIds: ['confirmed-draft'],
      draftSessionId: sessionId,
      draftsFolderId: 10,
    });
    expect(composeStore.sessionById(sessionId)).toBeNull();
  });

  it('converts a failed replacement into one discard obligation and waits for it', async () => {
    let attempts = 0;
    const { composeStore, repo } = await autosaveStore(async () => {
      attempts += 1;
      return attempts === 1
        ? { attempted: 1, succeeded: 0, failed: 1 }
        : { attempted: 1, succeeded: 1, failed: 0 };
    });
    repo.abandonPendingDraftMutation.mockResolvedValue({
      abandoned: 0,
      converted: 1,
      parked: 0,
      inFlight: 0,
      mutationId: 1,
    } as any);
    const sessionId = composeStore.open({ subject: 'Saved version' });
    const session = composeStore.sessionById(sessionId)!;
    session.confirmedRevision = {
      emailId: 'confirmed-draft',
      localMessageId: 23,
      revision: 1,
      messageId: '<confirmed@example.com>',
      payloadHash: 'confirmed-hash',
    };
    session.draft.subject = 'Failed replacement';

    await expect(composeStore.saveDraft(sessionId, { explicit: true })).resolves.toBe(false);
    await expect(composeStore.discardDraft(sessionId)).resolves.toBe(true);

    expect(repo.abandonPendingDraftMutation).toHaveBeenCalledWith(1, 1, {
      intent: 'discard-all',
      confirmedEmailIds: ['confirmed-draft'],
      draftSessionId: sessionId,
      draftsFolderId: 10,
    });
    expect(repo.insertPendingMutation).toHaveBeenCalledTimes(1);
    expect(repo.runMutation).toHaveBeenNthCalledWith(2, 1, 1);
    expect(composeStore.sessionById(sessionId)).toBeNull();
  });
});
