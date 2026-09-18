// @vitest-environment happy-dom

/**
 * Row tag chips in a mounted list (MK-6.5): every tag shows on the
 * preview line as a plain chip, the Tag button wears the first tag's
 * color, and it toggles the popover with focus returning to it.
 */

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { computed, nextTick } from 'vue';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

vi.mock('@tanstack/vue-virtual', () => ({
  useVirtualizer: (optionsRef) => computed(() => {
    const total = Number(optionsRef.value.count ?? 0);
    return {
      getTotalSize: () => total * 64,
      getVirtualItems: () => Array.from({ length: total }, (_, index) => ({
        index,
        key: optionsRef.value.getItemKey?.(index) ?? index,
        start: index * 64,
        size: 64,
      })),
      scrollToIndex: () => {},
      measure: () => {},
    };
  }),
}));

import MessageList from '../../../src/components/MessageList.vue';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useMailStore } from '../../../src/stores/mail-store';
import { DEFAULT_MESSAGE_TAGS } from '../../../src/utils/message-tags';

function makeRow(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    remote_id: `e-${id}`,
    from_text: `Sender ${id} <sender${id}@example.com>`,
    to_text: 'me@example.com',
    subject: `Subject ${id}`,
    preview: 'preview',
    received_at: 1_700_000_000_000 + id,
    is_seen: 1,
    is_flagged: 0,
    has_attachment: 0,
    keywords_json: '{}',
    ...overrides,
  } as any;
}

const mounted: Array<{ unmount: () => void }> = [];

function mountList(rows: any[]) {
  const mailStore = useMailStore();
  mailStore.folders = [{
    id: 1, account_id: 1, remote_id: 'mb-1', name: 'Inbox', role: 'inbox', sort_order: 0,
    parent_id: null, is_deleted: 0, total_emails: rows.length, unread_emails: 0,
  } as any];
  mailStore.currentFolderId = 1;
  mailStore.messages = rows;
  mailStore.totalForFolder = rows.length;
  const wrapper = mount(MessageList, { attachTo: document.body });
  mounted.push(wrapper);
  return { mailStore, wrapper };
}

beforeEach(() => {
  setActivePinia(createPinia());
  useAuthStore().accountId = 1;
});

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  vi.restoreAllMocks();
});

describe('MessageList tag view note', () => {
  it('stays a collapsed grid row in a folder and spells out truncation and account scope in a tag view', async () => {
    const { wrapper, mailStore } = mountList([makeRow(1)]);
    await nextTick();
    const note = wrapper.find('[data-tag-view-coverage]');
    expect(note.exists()).toBe(true);
    expect(note.classes()).toContain('is-idle');
    expect(note.text()).toBe('');

    const workId = mailStore.tagViewIdFor('$label2');
    mailStore.currentFolderId = workId;
    mailStore.tagCounts = new Map([['$label2', 2500]]);
    mailStore.accounts = [{ id: 1 }, { id: 2 }] as any;
    await nextTick();
    expect(note.classes()).not.toContain('is-idle');
    expect(note.text()).toBe(
      'Showing the newest 2,000 of 2,500 tagged messages. Shared folders are not included.',
    );
  });
});

describe('MessageList row tag chips', () => {
  it('draws up to three stacked tag icons in the tags\u2019 colors, then +N, as the row\u2019s tag control', async () => {
    const { wrapper } = mountList([
      makeRow(1, { keywords_json: '{"$label2":true,"receipts":true,"$label4":true,"$label1":true}' }),
      makeRow(2, { keywords_json: '{"receipts":true}' }),
      makeRow(3),
    ]);
    await nextTick();

    const rows = wrapper.findAll('.msg-list__item');
    expect(rows).toHaveLength(3);
    const stack = rows[0].find('.msg-list__action--tag');
    // Definition order, undefined keywords last; three icons, one folded.
    expect(stack.findAll('.tag-stack__icon').map((icon) => icon.attributes('data-tag-keyword')))
      .toEqual(['$label1', '$label2', '$label4']);
    expect(stack.find('.tag-stack__icon').attributes('style')).toContain(`--tag-color: ${DEFAULT_MESSAGE_TAGS[0].color}`);
    expect(stack.find('.tag-stack__more').text()).toBe('+1');
    expect(stack.attributes('aria-label')).toBe('Tags: Important, Work, To Do, receipts');
    expect(stack.classes()).toContain('is-tagged');
    // Tags no longer take a line of their own.
    expect(rows[0].find('.tag-chip').exists()).toBe(false);

    // An undefined keyword has no color and falls back to the text color.
    const undefinedIcon = rows[1].find('.msg-list__action--tag .tag-stack__icon');
    expect(undefinedIcon.attributes('style')).toBeUndefined();
    expect(rows[1].find('.tag-stack__more').exists()).toBe(false);

    // Untagged: the outline icon, shown only on hover.
    const empty = rows[2].find('.msg-list__action--tag');
    expect(empty.classes()).not.toContain('is-tagged');
    expect(empty.find('.tag-stack__icon--empty').exists()).toBe(true);
    expect(empty.attributes('aria-label')).toBe('Tag');
  });

  it('the row Tag button toggles the popover for that row and returns focus to it', async () => {
    const { wrapper } = mountList([makeRow(1, { keywords_json: '{"$label2":true}' }), makeRow(2)]);
    await nextTick();
    const tagButton = wrapper.findAll('.msg-list__action--tag')[0];
    // happy-dom lays nothing out; give the button a rectangle.
    vi.spyOn(tagButton.element, 'getClientRects').mockReturnValue([{}] as any);
    vi.spyOn(tagButton.element, 'getBoundingClientRect').mockReturnValue({
      top: 40, left: 500, width: 34, height: 28,
    } as DOMRect);

    await tagButton.trigger('click');
    await nextTick();
    await nextTick();
    const popover = document.querySelector('[data-tag-picker-popover]') as HTMLElement;
    expect(popover).not.toBeNull();
    expect(tagButton.attributes('aria-expanded')).toBe('true');
    expect(popover.querySelector('[data-tag-keyword="$label2"]')?.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(popover.querySelector('[data-tag-picker-clear]'));

    // The second click closes rather than reopening.
    await tagButton.trigger('click');
    await nextTick();
    await nextTick();
    expect(document.querySelector('[data-tag-picker-popover]')).toBeNull();
    expect(tagButton.attributes('aria-expanded')).toBe('false');
  });
});
