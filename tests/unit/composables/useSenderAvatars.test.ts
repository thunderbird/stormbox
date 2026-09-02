// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';

vi.mock('../../../src/defines', () => ({
  SENDER_AVATAR_PROXY_URL: 'https://avatars.example/proxy',
}));

import {
  provideSenderAvatars,
  useSenderAvatars,
  type SenderAvatars,
} from '../../../src/composables/useSenderAvatars';

const FROM = 'Ann <ann@corp.example>';

describe('useSenderAvatars', () => {
  it('stops retrying a domain once one of its avatars failed to load', () => {
    const { senderAvatar, onAvatarError } = useSenderAvatars();
    expect(senderAvatar(FROM).imageUrl).not.toBe('');

    onAvatarError(FROM);

    expect(senderAvatar(FROM).imageUrl).toBe('');
    expect(senderAvatar('Bob <bob@corp.example>').imageUrl).toBe('');
    expect(senderAvatar('Cy <cy@other.example>').imageUrl).not.toBe('');
  });

  it('keeps the failure memory per list, so a remounted list retries', () => {
    // MessageList forgot failed domains whenever it unmounted (mail →
    // contacts → mail); the shared composable must keep that behaviour
    // rather than turning it into a process-wide singleton.
    const first = useSenderAvatars();
    first.onAvatarError(FROM);
    expect(first.senderAvatar(FROM).imageUrl).toBe('');

    const second = useSenderAvatars();
    expect(second.senderAvatar(FROM).imageUrl).not.toBe('');
  });

  it('rows inside one list share the list\'s memory', () => {
    const rows: SenderAvatars[] = [];
    const Row = defineComponent({
      setup() {
        rows.push(useSenderAvatars());
        return () => h('li');
      },
    });
    const List = defineComponent({
      setup() {
        provideSenderAvatars();
        return () => h('ul', [h(Row), h(Row)]);
      },
    });
    const wrapper = mount(List);

    rows[0].onAvatarError(FROM);
    expect(rows[1].senderAvatar(FROM).imageUrl).toBe('');
    wrapper.unmount();

    // A fresh list starts clean.
    rows.length = 0;
    const again = mount(List);
    expect(rows[0].senderAvatar(FROM).imageUrl).not.toBe('');
    again.unmount();
  });
});
