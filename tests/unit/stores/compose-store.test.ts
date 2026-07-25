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

describe('compose-store send safety', () => {
  it('refuses to discard the draft while a send is in flight', () => {
    // The queued mutation keeps running in the worker after the dialog
    // closes, and its request payload is the only durable copy of the
    // message, so discarding here could lose the user's mail outright.
    const composeStore = useComposeStore();
    composeStore.open({ to: 'rcpt@example.com', subject: 'Keep me' });
    composeStore.status = COMPOSE_STATE.SENDING;

    expect(composeStore.close()).toBe(false);
    expect(composeStore.isOpen).toBe(true);
    expect(composeStore.draft.subject).toBe('Keep me');
    expect(composeStore.draft.to).toBe('rcpt@example.com');
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
      insertPendingMutation: vi.fn(async () => ({ id: 7 })),
      runMutation: vi.fn(() => new Promise((resolve) => { releaseMutation = resolve; })),
    };
    __setRepositoryForTests(repo);
    const authStore = useAuthStore();
    authStore.accountId = 1;
    const composeStore = useComposeStore();
    await composeStore.attach();
    await waitForAsyncWatchers();

    composeStore.open({ to: 'rcpt@example.com', subject: 'First' });
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
  async function composerWithOutcome(
    outcome: Record<string, unknown>,
    rowError?: Record<string, unknown>,
  ) {
    const repo = {
      subscribe: vi.fn(() => () => {}),
      getAccount: vi.fn(async () => ({ id: 1, primary_email: 'me@example.com' })),
      listIdentities: vi.fn(async () => [identity({ id: 1, email: 'me@example.com' })]),
      insertPendingMutation: vi.fn(async () => ({ id: 7 })),
      runMutation: vi.fn(async () => outcome),
      getPendingMutationError: vi.fn(async () => (rowError
        ? { mutation_type: 'send', local_status: 'conflicted', error_json: JSON.stringify(rowError) }
        : null)),
    };
    __setRepositoryForTests(repo);
    const authStore = useAuthStore();
    authStore.accountId = 1;
    const composeStore = useComposeStore();
    await composeStore.attach();
    await waitForAsyncWatchers();
    return composeStore;
  }

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
    composeStore.open({ to: 'rcpt@example.com', subject: 'Hello' });

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
    composeStore.open({ to: 'rcpt@example.com', subject: 'Hello' });

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
    composeStore.open({ to: 'rcpt@example.com', subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.status).toBe(COMPOSE_STATE.FAILED);
    expect(composeStore.error).toMatch(/Send failed/);
    expect(composeStore.notice).toBeNull();
    expect(composeStore.outcomeUnknown).toBe(false);
  });

  it('warns instead of blaming the send when the outcome is unknown', async () => {
    // Nothing here proves the message did not go out, so the copy must not
    // say it failed, and Send must not be offered again: a second press
    // builds a new message with a new Message-ID, which the duplicate
    // guard cannot recognise (CS-1.9).
    const composeStore = await composerWithOutcome(
      { attempted: 1, succeeded: 0, failed: 1, result: { filed: false } },
      { type: 'outcomeUnknown', terminal: true, reason: 'noEvidence' },
    );
    composeStore.open({ to: 'rcpt@example.com', subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.status).toBe(COMPOSE_STATE.FAILED);
    expect(composeStore.error).toMatch(/may already have been sent/i);
    expect(composeStore.error).not.toMatch(/failed/i);
    expect(composeStore.outcomeUnknown).toBe(true);
    expect(composeStore.isOpen).toBe(true);
  });

  it('recognises a send parked by crash recovery', async () => {
    // Startup recovery parks an interrupted send itself, without going
    // through the outbox. It records the same type, and the composer has
    // to read it the same way — the row's phase still says where the send
    // was interrupted, which is not what classifies it.
    const composeStore = await composerWithOutcome(
      { attempted: 1, succeeded: 0, failed: 1 },
      { type: 'outcomeUnknown', terminal: true, reason: 'interrupted' },
    );
    composeStore.open({ to: 'rcpt@example.com', subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.error).toMatch(/may already have been sent/i);
    expect(composeStore.outcomeUnknown).toBe(true);
  });

  it('blames the send when the failure was not ambiguous', async () => {
    const composeStore = await composerWithOutcome(
      { attempted: 1, succeeded: 0, failed: 1, result: { filed: false } },
      { type: 'notSubmitted', terminal: true, detail: { type: 'forbiddenFrom' } },
    );
    composeStore.open({ to: 'rcpt@example.com', subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.error).toMatch(/Send failed/);
    expect(composeStore.outcomeUnknown).toBe(false);
  });

  it('does not confirm a send the outbox never got to', async () => {
    // What a stopped runner reports: nothing attempted, nothing failed.
    // Reading that as success would confirm a message still sitting in
    // the queue.
    const composeStore = await composerWithOutcome({ attempted: 0, succeeded: 0, failed: 0 });
    composeStore.open({ to: 'rcpt@example.com', subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.status).toBe(COMPOSE_STATE.FAILED);
    expect(composeStore.notice).toBeNull();
    expect(composeStore.isOpen, 'the draft is still the only copy').toBe(true);
  });

  it('confirms a send the outbox had already retired', async () => {
    // The row was gone by the time the composer asked, which the runner
    // reports as a success with nothing attempted.
    const composeStore = await composerWithOutcome({ attempted: 0, succeeded: 1, failed: 0 });
    composeStore.open({ to: 'rcpt@example.com', subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(true);
    expect(composeStore.notice).toMatch(/accepted for delivery/);
  });

  it('takes the outbox at its word when the row is already gone', async () => {
    // A send interrupted by the worker shutting down is reported by the
    // outcome itself, with no row left to consult: the runner knows the
    // mutation was checked out to a worker that is going away, and for a
    // send that is not the same as knowing it failed.
    const composeStore = await composerWithOutcome({
      attempted: 1, succeeded: 0, failed: 1, errorType: 'outcomeUnknown',
    });
    composeStore.open({ to: 'rcpt@example.com', subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.error).toMatch(/may already have been sent/i);
    expect(composeStore.outcomeUnknown).toBe(true);
  });

  it('blames a stopped mutation that was safe to stop', async () => {
    const composeStore = await composerWithOutcome({
      attempted: 1, succeeded: 0, failed: 1, errorType: 'stopped',
    });
    composeStore.open({ to: 'rcpt@example.com', subject: 'Hello' });

    await expect(composeStore.send()).resolves.toBe(false);
    expect(composeStore.error).toMatch(/Send failed/);
    expect(composeStore.outcomeUnknown).toBe(false);
  });

  it('clears the unknown-outcome hold when the composer is reused', async () => {
    const composeStore = await composerWithOutcome(
      { attempted: 1, succeeded: 0, failed: 1, result: { filed: false } },
      { type: 'outcomeUnknown', terminal: true, reason: 'noEvidence' },
    );
    composeStore.open({ to: 'rcpt@example.com', subject: 'Hello' });
    await composeStore.send();
    expect(composeStore.outcomeUnknown).toBe(true);

    expect(composeStore.close()).toBe(true);
    expect(composeStore.outcomeUnknown).toBe(false);
  });
});
