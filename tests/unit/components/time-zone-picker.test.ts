// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
vi.mock('../../../src/services/auth', () => ({ initOidc: async () => null, getOidc: () => null }));
import TimeZonePicker from '../../../src/components/settings/TimeZonePicker.vue';
import { __resetRepositoryForTests, __setRepositoryForTests } from '../../../src/composables/useRepository';
import { AUTH_STATE } from '../../../src/constants/states';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useSettingsStore } from '../../../src/stores/settings-store';

enableAutoUnmount(afterEach);
beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  __resetRepositoryForTests();
});
afterEach(() => {
  useSettingsStore().detach();
  vi.restoreAllMocks();
  __resetRepositoryForTests();
});

describe('TimeZonePicker', () => {
  it('searches without saving and persists only a chosen valid IANA zone', async () => {
    const store = useSettingsStore();
    store.settings = { timeZone: 'America/New_York' };
    const update = vi.spyOn(store, 'update');
    const wrapper = mount(TimeZonePicker, { attachTo: document.body });
    await wrapper.get('input').setValue('Not/AZone');
    expect(wrapper.get('[role="status"]').text()).toBe('No matching IANA time zone');
    expect(update).not.toHaveBeenCalled();
    await wrapper.get('input').setValue('tokyo');
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(update).toHaveBeenCalledWith({ timeZone: 'Asia/Tokyo' });
    expect(wrapper.get('summary').text()).toBe('Asia/Tokyo');
    expect(document.activeElement).toBe(wrapper.get('summary').element);
  });
  it('explains that a failed sync keeps the zone locally and permits retrying', async () => {
    const applySettingsPatch = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ doc: { settings: { timeZone: 'Asia/Tokyo' } } });
    __setRepositoryForTests({
      subscribe: vi.fn(() => () => {}),
      ensureSettings: vi.fn(async () => {}),
      getSettings: vi.fn(async () => ({ doc: { settings: { timeZone: 'UTC' } } })),
      applySettingsPatch,
    });
    const auth = useAuthStore();
    auth.accountId = 1;
    auth.status = AUTH_STATE.CONNECTED;
    const store = useSettingsStore();
    await store.attach();
    await flushPromises();
    const wrapper = mount(TimeZonePicker);
    await wrapper.get('input').setValue('tokyo');
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.get('summary').text()).toBe('Asia/Tokyo');
    expect(JSON.parse(localStorage.getItem('stormbox.settings.v1')!).timeZone).toBe('Asia/Tokyo');
    expect(wrapper.get('[role="alert"]').text()).toContain('Time zone changed on this device');
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(applySettingsPatch).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });
});
