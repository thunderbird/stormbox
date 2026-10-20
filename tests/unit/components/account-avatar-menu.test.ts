// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import AccountAvatarMenu from '../../../src/components/AccountAvatarMenu.vue';

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => vi.restoreAllMocks());

it('links Support in the avatar menu directly to the contact page', () => {
  const wrapper = mount(AccountAvatarMenu);
  const link = wrapper.findAll('a[role="menuitem"]').find((item) => item.text() === 'Support');
  expect(link).toBeDefined();
  expect(link?.attributes('href')).toBe('https://accounts.tb.pro/contact');
  expect(link?.get('[aria-hidden="true"]').find('svg').exists()).toBe(true);
  wrapper.unmount();
});
