// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
vi.mock('../../../src/services/auth', () => ({ initOidc: async () => null, getOidc: () => null }));
import TimeZonePicker from '../../../src/components/settings/TimeZonePicker.vue';
import { useSettingsStore } from '../../../src/stores/settings-store';

enableAutoUnmount(afterEach);
beforeEach(() => { setActivePinia(createPinia()); localStorage.clear(); });
afterEach(() => vi.restoreAllMocks());

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
  it('keeps a failed save visible and permits retrying the selected zone', async () => {
    const store = useSettingsStore();
    const update = vi.spyOn(store, 'update').mockRejectedValueOnce(new Error('offline'));
    const wrapper = mount(TimeZonePicker);
    await wrapper.get('input').setValue('tokyo');
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('could not be saved');
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });
});
