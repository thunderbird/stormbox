// @vitest-environment happy-dom

import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import { useComposeStore } from '../../../src/stores/compose-store';

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
