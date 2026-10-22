// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/defines', () => ({
  SENDER_AVATAR_PROXY_URL: 'https://avatars.example/proxy',
}));

import MessageListRow from '../../../src/components/MessageListRow.vue';

function mountRow(fromText: string | null) {
  return mount(MessageListRow, {
    props: {
      message: { id: 1, from_text: fromText, subject: 'Avatar test' },
      index: 0,
      start: 0,
      size: 64,
    },
  });
}

describe('MessageListRow avatar', () => {
  it('leaves transparent images free of fallback initials and background', () => {
    const wrapper = mountRow('Ann Example <ann@example.org>');
    const avatar = wrapper.get('.msg-list__avatar');
    expect(avatar.get('img').attributes('src')).toContain('/example.org?');
    expect(avatar.find('span').exists()).toBe(false);
    expect((avatar.element as HTMLElement).style.background).toBe('');
    wrapper.unmount();
  });

  it('restores the fallback on image failure and clears it for a new domain', async () => {
    const wrapper = mountRow('Ann Example <ann@example.org>');
    const avatar = wrapper.get('.msg-list__avatar');
    await avatar.get('img').trigger('error');
    expect(avatar.find('img').exists()).toBe(false);
    expect(avatar.get('span').text()).toBe('AE');

    await wrapper.setProps({
      message: { id: 2, from_text: 'Bob Other <bob@other.example>', subject: 'New domain' },
    });
    expect(avatar.get('img').attributes('src')).toContain('/other.example?');
    expect(avatar.find('span').exists()).toBe(false);
    expect((avatar.element as HTMLElement).style.background).toBe('');
    wrapper.unmount();
  });

  it('shows the fallback when the sender has no usable domain', () => {
    const wrapper = mountRow(null);
    const avatar = wrapper.get('.msg-list__avatar');
    expect(avatar.find('img').exists()).toBe(false);
    expect(avatar.get('span').text()).toBe('?');
    wrapper.unmount();
  });
});
