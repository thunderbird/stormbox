// @vitest-environment happy-dom

import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import StorageUsageBar from '../../../src/components/StorageUsageBar.vue';
import { useAuthStore } from '../../../src/stores/auth-store';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('StorageUsageBar', () => {
  it('renders the percent-of-limit label and fill width when the server reports a hard limit (R-7.1)', () => {
    const authStore = useAuthStore();
    authStore.quotaUsedBytes = 512 * 1024 * 1024; // 512 MB
    authStore.quotaHardLimitBytes = 1024 * 1024 * 1024; // 1 GB

    const wrapper = mount(StorageUsageBar);

    const root = wrapper.find('.storage-usage');
    expect(root.exists()).toBe(true);

    // Percent is 512 / 1024 = 50%, label includes the formatted total.
    expect(wrapper.text()).toMatch(/50% of 1 GB/);

    const fill = wrapper.find('.storage-usage__fill');
    expect(fill.attributes('style')).toContain('width: 50%');
  });

  it('hides the indicator entirely when the server does not advertise a hard limit (R-7.2)', () => {
    const authStore = useAuthStore();
    authStore.quotaUsedBytes = 1024;
    authStore.quotaHardLimitBytes = null;

    const wrapper = mount(StorageUsageBar);

    expect(wrapper.find('.storage-usage').exists()).toBe(false);
  });
});
