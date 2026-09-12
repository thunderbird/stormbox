// @vitest-environment happy-dom

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import StoreErrorToast from '../../../src/components/StoreErrorToast.vue';
import { __resetRepositoryForTests } from '../../../src/composables/useRepository';
import { COMPOSE_STATE } from '../../../src/constants/states';
import {
  COMPOSE_PRESENTATION,
  sessionLabel,
  useComposeStore,
} from '../../../src/stores/compose-store';

const mountedWrappers: Array<{ unmount: () => void }> = [];

function mountToast() {
  const wrapper = mount(StoreErrorToast, { attachTo: document.body });
  mountedWrappers.push(wrapper);
  return wrapper;
}

/** A session in the state performSend leaves it in once it has claimed the lane. */
function sendingSession(subject: string, scheduledAt: string | null = null) {
  const composeStore = useComposeStore();
  const id = composeStore.open({ to: [{ email: 'rcpt@example.com' }], subject });
  const session = composeStore.sessionById(id)!;
  session.status = COMPOSE_STATE.SENDING;
  session.sendingScheduledAt = scheduledAt;
  session.presentation = COMPOSE_PRESENTATION.HIDDEN;
  if (composeStore.activeSessionId === id) composeStore.activeSessionId = null;
  return { composeStore, id, session };
}

beforeEach(() => {
  setActivePinia(createPinia());
  __resetRepositoryForTests();
});

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  __resetRepositoryForTests();
});

describe('StoreErrorToast send progress', () => {
  it('stands in for a session while it sends and offers nothing to press', async () => {
    // The toast is the session's only representation while its send is
    // unresolved (CS-1.16): no Restore, no Close, no dismiss.
    const { id, session } = sendingSession('Quarterly numbers');
    const wrapper = mountToast();
    await nextTick();

    const item = wrapper.get(`.store-error-toast__item[data-session-id="${id}"]`);
    expect(item.classes()).toContain('store-error-toast__item--progress');
    expect(item.attributes('aria-busy')).toBe('true');
    expect(item.text()).toBe('Sending “Quarterly numbers”…');
    expect(item.find('.store-error-toast__progress').exists()).toBe(true);
    expect(item.find('button').exists()).toBe(false);
    expect(wrapper.get('.store-error-toast').attributes('role')).toBe('status');

    session.sendingScheduledAt = '2026-10-01T12:00:00Z';
    await nextTick();
    expect(item.text()).toBe('Scheduling “Quarterly numbers”…');
  });

  it('names the session the way the dock does', async () => {
    const composeStore = useComposeStore();
    const id = composeStore.open({ to: [{ name: 'Ada Lovelace', email: 'ada@example.com' }] });
    const session = composeStore.sessionById(id)!;
    expect(sessionLabel(session)).toBe('Ada Lovelace');
    session.draft.to = [{ email: 'ada@example.com' }];
    expect(sessionLabel(session)).toBe('ada@example.com');
    session.draft.to = [];
    expect(sessionLabel(session)).toBe('New message');
    session.draft.subject = '  Hello  ';
    expect(sessionLabel(session)).toBe('Hello');

    session.status = COMPOSE_STATE.SENDING;
    session.presentation = COMPOSE_PRESENTATION.HIDDEN;
    const wrapper = mountToast();
    await nextTick();
    expect(wrapper.get(`[data-session-id="${id}"]`).text()).toBe('Sending “Hello”…');
  });

  it('turns into the failure notice with Open when the session docked, in the same toast', async () => {
    // Failing while another composer is expanded docks the session; the
    // toast the user was watching becomes the failure and opens it (CS-1.16).
    const { composeStore, id, session } = sendingSession('Refused');
    const otherId = composeStore.open({ subject: 'Other' });
    const wrapper = mountToast();
    await nextTick();
    const element = wrapper.get(`[data-session-id="${id}"]`).element;

    session.status = COMPOSE_STATE.FAILED;
    session.sendingScheduledAt = null;
    session.error = 'Send failed; the message stays in your outbox.';
    session.presentation = COMPOSE_PRESENTATION.MINIMIZED;
    session.dockedSendFailure = true;
    await nextTick();

    const item = wrapper.get(`[data-session-id="${id}"]`);
    expect(item.element).toBe(element);
    expect(item.classes()).not.toContain('store-error-toast__item--progress');
    expect(item.classes()).not.toContain('store-error-toast__item--success');
    expect(item.attributes('aria-busy')).toBeUndefined();
    expect(item.get('.store-error-toast__message').text()).toBe('Couldn’t send “Refused”.');
    expect(item.find('.store-error-toast__progress').exists()).toBe(false);
    expect(item.get('.store-error-toast__dismiss').attributes('aria-label'))
      .toBe('Dismiss the send failure of “Refused”');
    expect(item.get('.store-error-toast__action').attributes('aria-label')).toBe('Open “Refused”');

    await item.get('.store-error-toast__action').trigger('click');
    expect(session.presentation).toBe(COMPOSE_PRESENTATION.EXPANDED);
    expect(composeStore.activeSessionId).toBe(id);
    expect(composeStore.sessionById(otherId)?.presentation).toBe(COMPOSE_PRESENTATION.MINIMIZED);
    expect(session.dockedSendFailure).toBe(false);
    await nextTick();
    expect(wrapper.find(`[data-session-id="${id}"]`).exists()).toBe(false);
  });

  it('dismisses the failure notice and leaves the session in the dock', async () => {
    const { composeStore, id, session } = sendingSession('Refused');
    composeStore.open({ subject: 'Other' });
    session.status = COMPOSE_STATE.FAILED;
    session.error = 'Send failed; the message stays in your outbox.';
    session.presentation = COMPOSE_PRESENTATION.MINIMIZED;
    session.dockedSendFailure = true;
    const wrapper = mountToast();
    await nextTick();

    await wrapper.get(`[data-session-id="${id}"] .store-error-toast__dismiss`).trigger('click');
    expect(session.dockedSendFailure).toBe(false);
    expect(session.presentation).toBe(COMPOSE_PRESENTATION.MINIMIZED);
    await nextTick();
    expect(wrapper.find(`[data-session-id="${id}"]`).exists()).toBe(false);
  });

  it('names Open and Dismiss after their session when several failures are showing', async () => {
    // Two failures give two Open and two Dismiss buttons; each accessible
    // name has to say which message it acts on.
    const composeStore = useComposeStore();
    const subjects = ['First refused', 'Second refused'];
    const ids = subjects.map((subject) => {
      const id = composeStore.open({ to: [{ email: 'rcpt@example.com' }], subject });
      const session = composeStore.sessionById(id)!;
      session.status = COMPOSE_STATE.FAILED;
      session.error = 'Send failed; the message stays in your outbox.';
      composeStore.minimize(id);
      session.dockedSendFailure = true;
      return id;
    });
    composeStore.open({ subject: 'Other' });
    const wrapper = mountToast();
    await nextTick();

    const names = (selector: string) => ids.map((id) =>
      wrapper.get(`[data-session-id="${id}"] ${selector}`).attributes('aria-label'));
    const openNames = names('.store-error-toast__action');
    const dismissNames = names('.store-error-toast__dismiss');
    expect(new Set(openNames).size).toBe(2);
    expect(new Set(dismissNames).size).toBe(2);
    subjects.forEach((subject, index) => {
      expect(openNames[index]).toContain(subject);
      expect(dismissNames[index]).toContain(subject);
      expect(wrapper.get(`[data-session-id="${ids[index]}"] .store-error-toast__action`).text())
        .toBe('Open');
    });
  });

  it('shows no toast for a minimized session whose failure the user has already seen', async () => {
    // A failed composer the user minimized is a plain dock item; only a
    // failure that docked the session from off screen owes a notice.
    const composeStore = useComposeStore();
    const id = composeStore.open({ to: [{ email: 'rcpt@example.com' }], subject: 'Seen' });
    const session = composeStore.sessionById(id)!;
    session.status = COMPOSE_STATE.FAILED;
    session.error = 'Send failed; the message stays in your outbox.';
    composeStore.minimize(id);
    const wrapper = mountToast();
    await nextTick();
    expect(wrapper.find('.store-error-toast').exists()).toBe(false);
  });

  it('keeps the send confirmation after the sending toast has left', async () => {
    // Acceptance closes the session, so its progress entry goes and the
    // CS-1.13 confirmation takes its place.
    const { composeStore, id } = sendingSession('Quick');
    const wrapper = mountToast();
    await nextTick();
    expect(wrapper.get(`[data-session-id="${id}"]`).classes())
      .toContain('store-error-toast__item--progress');

    composeStore.sessions = composeStore.sessions.filter((session) => session.id !== id);
    composeStore.notice = 'Message accepted for delivery.';
    await nextTick();
    expect(wrapper.find(`[data-session-id="${id}"]`).exists()).toBe(false);
    const success = wrapper.get('.store-error-toast__item--success');
    expect(success.text()).toBe('Message accepted for delivery.');
    expect(success.find('.store-error-toast__dismiss').exists()).toBe(true);
  });
});
