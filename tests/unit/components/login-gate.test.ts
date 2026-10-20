// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../../src/services/auth', () => ({ initOidc: async () => null, getOidc: () => null }));

import LoginGate from '../../../src/components/LoginGate.vue';
import { useAuthStore } from '../../../src/stores/auth-store';
import { AUTH_STATE } from '../../../src/constants/states';

const mounted: Array<ReturnType<typeof mount>> = [];

function mountGate() {
  const wrapper = mount(LoginGate, { attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  mounted.splice(0).forEach(wrapper => wrapper.unmount());
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('LoginGate', () => {
  it('shows only a transient connection status during OIDC startup', () => {
    const wrapper = mountGate();
    expect(wrapper.find('[role="status"]').text()).toContain('Connecting');
    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.find('button').exists()).toBe(false);
    expect(wrapper.find('.login-card').exists()).toBe(false);
  });

  it('offers an explicit retry after an OIDC failure', async () => {
    const store = useAuthStore();
    store.status = AUTH_STATE.FAILED;
    store.error = 'Identity provider unavailable';
    const retry = vi.spyOn(store, 'retryOidc').mockResolvedValue();
    const wrapper = mountGate();

    expect(wrapper.find('[role="alert"]').text()).toBe(store.error);
    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.find('.login-card__spinner').exists()).toBe(false);
    await wrapper.get('button').trigger('click');
    expect(retry).toHaveBeenCalledOnce();
  });

  it('explains an offline startup while waiting for connectivity', () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const wrapper = mountGate();
    expect(wrapper.get('[role="status"]').text()).toContain('offline');
  });

  it('opens the explicit app-password form directly and keeps its values during a connection', async () => {
    window.history.replaceState(null, '', '/?app-password');
    const store = useAuthStore();
    const connect = vi.spyOn(store, 'connectWithPassword').mockResolvedValue(false);
    const wrapper = mountGate();
    const username = wrapper.get('input[autocomplete="username"]');
    const password = wrapper.get('input[autocomplete="current-password"]');
    await username.setValue('tester@example.org');
    await password.setValue('secret');
    await wrapper.get('form').trigger('submit');
    expect(connect).toHaveBeenCalledWith({ username: 'tester@example.org', password: 'secret' });

    store.status = AUTH_STATE.CONNECTING;
    await flushPromises();
    expect(wrapper.get('input[autocomplete="username"]').element).toBe(username.element);
    expect((password.element as HTMLInputElement).value).toBe('secret');
    expect(username.attributes('disabled')).toBeDefined();
    store.status = AUTH_STATE.FAILED;
    store.error = 'Invalid app password';
    await flushPromises();
    expect(username.attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[role="alert"]').text()).toBe('Invalid app password');
  });

  it('honors the persisted app-password preference', () => {
    localStorage.setItem('stormbox.appPassword', '1');
    const wrapper = mountGate();
    expect(wrapper.find('form').exists()).toBe(true);
    expect(wrapper.find('.login-progress').exists()).toBe(false);
  });

  it('consumes the staff auto-login flag without changing the remaining URL', () => {
    window.history.replaceState(null, '', '/inbox?view=compact&auto-login=1#message');
    mountGate();
    expect(window.location.pathname + window.location.search + window.location.hash)
      .toBe('/inbox?view=compact#message');
  });

  it('leaves a canceled OIDC redirect retryable when restored from the back-forward cache', () => {
    const store = useAuthStore();
    const cancel = vi.spyOn(store, 'cancelOidcLogin');
    mountGate();
    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: true });
    window.dispatchEvent(event);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
