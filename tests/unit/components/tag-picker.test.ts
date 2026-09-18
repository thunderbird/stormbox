// @vitest-environment happy-dom

/**
 * The tag menu (MK-6.6): Remove All Tags, tri-state checkboxes over the
 * target rows, the target rows' undefined keywords, "Manage Tags…", and
 * the digit keys while it has focus. Actions emit and leave the panel
 * open; the owner applies the change through the store.
 */

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import MessageListRow from '../../../src/components/MessageListRow.vue';
import MessageTagChip from '../../../src/components/MessageTagChip.vue';
import TagPickerDropdown from '../../../src/components/TagPickerDropdown.vue';
import TagPickerPanel from '../../../src/components/TagPickerPanel.vue';
import { DEFAULT_MESSAGE_TAGS } from '../../../src/utils/message-tags';

const definitions = DEFAULT_MESSAGE_TAGS;

function row(id: number, keywordsJson: string) {
  return { id, keywords_json: keywordsJson };
}

function checked(wrapper: ReturnType<typeof mount>) {
  return Object.fromEntries(
    wrapper.findAll('[role="menuitemcheckbox"]').map((item) => [
      item.attributes('data-tag-keyword'),
      item.attributes('aria-checked'),
    ]),
  );
}

describe('TagPickerPanel', () => {
  it('has no find field, and offers Remove All Tags first only while a target carries a tag', async () => {
    const wrapper = mount(TagPickerPanel, {
      props: { definitions, targets: [row(1, '{"$label2":true}'), row(2, '{"receipts":true,"$seen":true}')] },
    });
    expect(wrapper.find('input').exists()).toBe(false);
    const clear = wrapper.find('[data-tag-picker-clear]');
    expect(clear.text()).toContain('Remove All Tags');
    expect(clear.find('kbd').text()).toBe('0');
    expect(wrapper.find('[role^="menuitem"]').attributes('data-tag-picker-clear')).toBeDefined();
    await clear.trigger('click');
    expect(wrapper.emitted('clear')).toHaveLength(1);
    expect(wrapper.find('[data-tag-picker-manage]').text()).toContain('Manage Tags…');

    await wrapper.setProps({ targets: [row(1, '{"$seen":true}')] });
    expect(wrapper.find('[data-tag-picker-clear]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('toggles by digit and removes every tag with 0 while the menu has focus', async () => {
    const wrapper = mount(TagPickerPanel, {
      attachTo: document.body,
      props: { definitions, targets: [row(1, '{"$label2":true}')] },
    });
    const menu = wrapper.find('[role="menu"]');
    const press = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      menu.element.dispatchEvent(event);
      return event;
    };

    expect(press('3').defaultPrevented).toBe(true);
    // Work is on every target, so its digit removes it.
    press('2');
    // Shifted digits (AZERTY) count; modified ones are left alone.
    press('4', { shiftKey: true });
    expect(press('5', { ctrlKey: true }).defaultPrevented).toBe(false);
    // Past the defined tags the digit does nothing.
    press('9');
    expect(wrapper.emitted('toggle')).toEqual([['$label3', true], ['$label2', false], ['$label4', true]]);

    press('0');
    expect(wrapper.emitted('clear')).toHaveLength(1);
    // T, which opens the menu, closes it; Ctrl+T is the browser's.
    expect(press('T', { shiftKey: true }).defaultPrevented).toBe(true);
    press('t');
    expect(press('t', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(wrapper.emitted('close')).toHaveLength(2);
    expect(wrapper.find('[data-tag-keyword="$label1"]').attributes('aria-keyshortcuts')).toBe('1');
    wrapper.unmount();
  });

  it('shows every definition in order with tri-state checks over the targets', () => {
    const wrapper = mount(TagPickerPanel, {
      props: {
        definitions,
        targets: [
          row(1, '{"$label1":true,"$label2":true}'),
          row(2, '{"$label1":true}'),
        ],
      },
    });

    expect(wrapper.findAll('[role="menuitemcheckbox"]').map((i) => i.text())).toEqual([
      'Important1', 'Work2', 'Personal3', 'To Do4', 'Later5',
    ]);
    expect(checked(wrapper)).toEqual({
      $label1: 'true',
      $label2: 'mixed',
      $label3: 'false',
      $label4: 'false',
      $label5: 'false',
    });
  });

  it('toggles: adds when not every target has the tag, removes when all do', async () => {
    const wrapper = mount(TagPickerPanel, {
      props: {
        definitions,
        targets: [row(1, '{"$label1":true,"$label2":true}'), row(2, '{"$label1":true}')],
      },
    });

    await wrapper.find('[data-tag-keyword="$label2"]').trigger('click');
    await wrapper.find('[data-tag-keyword="$label1"]').trigger('click');
    await wrapper.find('[data-tag-keyword="$label3"]').trigger('click');

    expect(wrapper.emitted('toggle')).toEqual([
      ['$label2', true],
      ['$label1', false],
      ['$label3', true],
    ]);
  });

  it('lists the targets\u2019 keywords that have no definition under Other keywords', async () => {
    const wrapper = mount(TagPickerPanel, {
      props: {
        definitions,
        targets: [row(1, '{"receipts":true,"$seen":true}'), row(2, '{}')],
      },
    });

    expect(wrapper.find('.tag-picker__heading').text()).toBe('Other keywords');
    const other = wrapper.find('[data-tag-keyword="receipts"]');
    expect(other.attributes('aria-checked')).toBe('mixed');
    expect(other.classes()).toContain('tag-picker__item--undefined');
    await other.trigger('click');
    expect(wrapper.emitted('toggle')).toEqual([['receipts', true]]);
    expect(wrapper.find('[data-tag-keyword="$seen"]').exists()).toBe(false);
  });

  it('Manage Tags… emits manage, and an empty menu says no tags are defined', async () => {
    const wrapper = mount(TagPickerPanel, { props: { definitions, targets: [row(1, '{}')] } });
    await wrapper.find('[data-tag-picker-manage]').trigger('click');
    expect(wrapper.emitted('manage')).toHaveLength(1);

    await wrapper.setProps({ definitions: [] });
    expect(wrapper.find('.tag-picker__empty').text()).toBe('No tags defined yet.');
  });
});

describe('TagPickerDropdown', () => {
  it('renders a toolbar trigger and forwards the panel events', async () => {
    const wrapper = mount(TagPickerDropdown, {
      props: {
        definitions,
        targets: [row(1, '{}')],
        label: 'Tag selected messages',
        title: 'Tag',
      },
      attachTo: document.body,
    });
    const trigger = wrapper.find('[data-tag-picker-trigger]');
    expect(trigger.attributes('aria-label')).toBe('Tag selected messages');
    expect(trigger.attributes('title')).toBe('Tag');
    expect(trigger.classes()).toContain('tag-picker-dropdown__trigger');

    const details = wrapper.find('details');
    (details.element as HTMLDetailsElement).open = true;
    await details.trigger('toggle');
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(wrapper.find('[data-tag-keyword="$label1"]').element);

    await wrapper.find('[data-tag-keyword="$label4"]').trigger('click');
    expect(wrapper.emitted('toggle')).toEqual([['$label4', true]]);
    // A toggle keeps the menu open.
    expect((details.element as HTMLDetailsElement).open).toBe(true);

    // T closes it and hands focus back to the trigger.
    await wrapper.find('[role="menu"]').trigger('keydown', { key: 't' });
    expect((details.element as HTMLDetailsElement).open).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    wrapper.unmount();
  });
});

describe('MessageListRow tag chips (MK-6.5)', () => {
  function mountRow(keywordsJson: string) {
    return mount(MessageListRow, {
      props: {
        message: {
          id: 7,
          subject: 'Tagged',
          from_text: 'Ada <ada@example.com>',
          received_at: 1_700_000_000_000,
          is_seen: 1,
          is_flagged: 0,
          has_attachment: 0,
          keywords_json: keywordsJson,
        },
        index: 0,
        start: 0,
        size: 64,
        tagDefinitions: definitions,
        hoverActions: true,
      },
    });
  }

  it('stacks at most three tag icons in definition order, folds the rest into +N, and skips system keywords', () => {
    const wrapper = mountRow('{"receipts":true,"$label3":true,"$label1":true,"$seen":true,"$label2":true}');
    const stack = wrapper.find('.msg-list__action--tag');
    expect(stack.findAll('.tag-stack__icon').map((icon) => icon.attributes('data-tag-keyword')))
      .toEqual(['$label1', '$label2', '$label3']);
    expect(stack.find('.tag-stack__more').text()).toBe('+1');
    expect(stack.attributes('title')).toBe('Tags: Important, Work, Personal, receipts');

    expect(mountRow('{"$label2":true}').find('.tag-stack__more').exists()).toBe(false);
    const untagged = mountRow('{"$seen":true}').find('.msg-list__action--tag');
    expect(untagged.classes()).not.toContain('is-tagged');
    expect(untagged.find('.tag-stack__icon--empty').exists()).toBe(true);
  });

  it('shows a tagged row\u2019s stack without the hover overlay, and opens the menu from it without selecting the row', async () => {
    const scheduled = mount(MessageListRow, {
      props: {
        message: {
          id: 8, subject: 'Later', from_text: 'Ada <ada@example.com>', received_at: 1_700_000_000_000,
          is_seen: 1, is_flagged: 0, has_attachment: 0, keywords_json: '{"$label2":true}',
        },
        index: 0, start: 0, size: 64, tagDefinitions: definitions, hoverActions: false,
      },
    });
    expect(scheduled.find('.msg-list__icons .tag-stack').attributes('title')).toBe('Tags: Work');
    expect(scheduled.find('.msg-list__action--tag').exists()).toBe(false);

    const wrapper = mountRow('{"$label2":true}');
    await wrapper.find('.msg-list__action--tag').trigger('click');
    expect(wrapper.emitted('tag')).toHaveLength(1);
    expect(wrapper.emitted('row-click')).toBeUndefined();
  });
});

describe('MessageTagChip', () => {
  it('colors a defined tag, dashes an undefined keyword, and emits remove', async () => {
    const wrapper = mount(MessageTagChip, {
      props: {
        tag: { keyword: '$label2', name: 'Work', color: '#FF9900', defined: true },
        removable: true,
      },
    });
    expect(wrapper.attributes('style')).toContain('--tag-color: #FF9900');
    await wrapper.find('.tag-chip__remove').trigger('click');
    expect(wrapper.emitted('remove')?.[0]?.[0]).toMatchObject({ keyword: '$label2' });

    const plain = mount(MessageTagChip, {
      props: { tag: { keyword: 'receipts', name: 'receipts', color: null, defined: false } },
    });
    expect(plain.classes()).toContain('tag-chip--undefined');
    expect(plain.find('button').exists()).toBe(false);
    expect(plain.text()).toBe('receipts');
  });
});
