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
    received_at: Date.parse('2026-05-22T12:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  __resetRepositoryForTests();
  window.localStorage.clear();
});

describe('compose-store reply and forward prefills', () => {
  it('prepares a reply addressed to the original sender with quoted content', () => {
    const composeStore = useComposeStore();

    composeStore.prepareReplyFromMessage(sourceMessage(), {
      html: '<p>Hello from Alice</p>',
      text: 'Hello from Alice',
    });

    expect(composeStore.isOpen).toBe(true);
    expect(composeStore.draft.to).toBe('Alice <alice@example.com>');
    expect(composeStore.draft.cc).toBe('');
    expect(composeStore.draft.subject).toBe('Re: Project update');
    expect(composeStore.draft.htmlBody).toContain('From: Alice &lt;alice@example.com&gt;');
    expect(composeStore.draft.htmlBody).toContain('<blockquote type="cite"><p>Hello from Alice</p></blockquote>');
    expect(composeStore.draft.textBody).toContain('> Hello from Alice');
  });

  it('prepares reply-all with the sender in To and non-self recipients in Cc', () => {
    const composeStore = useComposeStore();
    composeStore.identities = [{ id: 1, name: 'Me', email: 'me@example.com' } as any];

    composeStore.prepareReplyAll(sourceMessage(), {
      text: 'Looping everyone in',
    });

    expect(composeStore.isOpen).toBe(true);
    expect(composeStore.draft.to).toBe('Alice <alice@example.com>');
    expect(composeStore.draft.cc).toBe('Bob <bob@example.com>');
    expect(composeStore.draft.textBody).toContain('> Looping everyone in');
  });

  it('prepares a forward without recipients and with a forwarded subject', () => {
    const composeStore = useComposeStore();

    composeStore.prepareForward(sourceMessage(), {
      html: '<p>Forward this</p>',
      text: 'Forward this',
    });

    expect(composeStore.isOpen).toBe(true);
    expect(composeStore.draft.to).toBe('');
    expect(composeStore.draft.cc).toBe('');
    expect(composeStore.draft.subject).toBe('Fwd: Project update');
    expect(composeStore.draft.htmlBody).toContain('<blockquote type="cite"><p>Forward this</p></blockquote>');
    expect(composeStore.draft.textBody).toContain('> Forward this');
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
