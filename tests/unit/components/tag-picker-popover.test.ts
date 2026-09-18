// @vitest-environment happy-dom

/**
 * The teleported tag menu shares AppDropdown's dismissal contract: a
 * pointer down outside closes it (the trigger excepted, so it toggles),
 * so do Escape, Tab, scroll and resize; focus goes to the find field on
 * open and back to the trigger on close; listeners leave with the panel.
 */

import {
  afterEach, describe, expect, it, vi,
} from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import TagPickerPopover from '../../../src/components/TagPickerPopover.vue';
import { DEFAULT_MESSAGE_TAGS } from '../../../src/utils/message-tags';

const anchor = {
  top: 100, left: 300, width: 34, height: 28,
};

const mounted: Array<{ unmount: () => void }> = [];

function mountPopover(props: Record<string, unknown> = {}) {
  const trigger = document.createElement('button');
  trigger.textContent = 'Tag';
  document.body.appendChild(trigger);
  const outside = document.createElement('button');
  outside.textContent = 'Elsewhere';
  document.body.appendChild(outside);
  const wrapper = mount(TagPickerPopover, {
    props: {
      anchor: null,
      targets: [{ id: 1, keywords_json: '{"$label2":true}' }],
      definitions: DEFAULT_MESSAGE_TAGS,
      trigger,
      ...props,
    },
    attachTo: document.body,
  });
  mounted.push(wrapper, { unmount: () => { trigger.remove(); outside.remove(); } });
  return { wrapper, trigger, outside };
}

async function settle() {
  await nextTick();
  await nextTick();
}

function panel() {
  return document.querySelector('[data-tag-picker-popover]');
}

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  vi.restoreAllMocks();
});

describe('TagPickerPopover', () => {
  it('opens on the anchor with focus on the first item, and returns focus to the trigger on close', async () => {
    const { wrapper, trigger } = mountPopover();
    trigger.focus();
    await wrapper.setProps({ anchor });
    await settle();

    const root = panel() as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.getAttribute('role')).toBe('dialog');
    expect(root.style.position).toBe('fixed');
    expect(document.activeElement).toBe(root.querySelector('[data-tag-picker-clear]'));
    expect(root.querySelector('[data-tag-keyword="$label2"]')?.getAttribute('aria-checked')).toBe('true');

    await wrapper.setProps({ anchor: null, trigger: null });
    await settle();
    expect(panel()).toBeNull();
    // The element captured at open time gets focus back, even though the
    // props were reset together.
    expect(document.activeElement).toBe(trigger);
  });

  it('opens below when it fits, above when only that fits, and otherwise scrolls on the roomier side', async () => {
    let natural = 300;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function scrollHeight(this: HTMLElement) {
      return this.classList.contains('tag-picker') ? natural : 0;
    });
    const viewport = window.innerHeight;
    const { wrapper } = mountPopover();
    const place = async (top: number) => {
      await wrapper.setProps({ anchor: null });
      await settle();
      await wrapper.setProps({ anchor: { ...anchor, top } });
      await settle();
      const root = panel() as HTMLElement;
      return { top: parseFloat(root.style.top), maxHeight: parseFloat(root.style.maxHeight) };
    };

    // Room below: under the anchor, capped at the room there.
    expect(await place(100)).toEqual({ top: 134, maxHeight: viewport - 8 - 134 });
    // Not enough below but enough above: its full height, above the anchor.
    const nearBottom = viewport - 140;
    expect(await place(nearBottom)).toEqual({ top: nearBottom - 6 - 300, maxHeight: nearBottom - 6 - 8 });
    // Taller than either side: the roomier side, scrolling.
    natural = viewport;
    const middle = Math.round(viewport / 2) + 20;
    expect(await place(middle)).toEqual({ top: 8, maxHeight: middle - 6 - 8 });
  });

  it('closes on an outside pointer down, Escape, Tab, scroll and resize, but not on the trigger', async () => {
    const { wrapper, trigger, outside } = mountPopover();
    await wrapper.setProps({ anchor });
    await settle();

    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(wrapper.emitted('close')).toBeUndefined();

    (panel() as HTMLElement).querySelector('[data-tag-picker-manage]')!
      .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(wrapper.emitted('close')).toBeUndefined();

    outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(wrapper.emitted('close')).toHaveLength(1);

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(wrapper.emitted('close')).toHaveLength(2);

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    (panel() as HTMLElement).dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(wrapper.emitted('close')).toHaveLength(3);

    document.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(wrapper.emitted('close')).toHaveLength(4);
    window.dispatchEvent(new Event('resize'));
    expect(wrapper.emitted('close')).toHaveLength(5);
  });

  it('removes its document listeners when it closes and when it unmounts', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const { wrapper, outside } = mountPopover();
    await wrapper.setProps({ anchor });
    await settle();
    const added = add.mock.calls.filter(([type]) => type === 'pointerdown' || type === 'keydown' || type === 'scroll');
    expect(added).toHaveLength(3);

    await wrapper.setProps({ anchor: null });
    await settle();
    const removed = remove.mock.calls.filter(([type]) => type === 'pointerdown' || type === 'keydown' || type === 'scroll');
    expect(removed).toHaveLength(3);

    outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('forwards toggle, clear and manage from the panel', async () => {
    const { wrapper } = mountPopover();
    await wrapper.setProps({ anchor });
    await settle();
    const root = panel() as HTMLElement;

    (root.querySelector('[data-tag-keyword="$label3"]') as HTMLElement).click();
    expect(wrapper.emitted('toggle')).toEqual([['$label3', true]]);

    (root.querySelector('[data-tag-picker-clear]') as HTMLElement).click();
    expect(wrapper.emitted('clear')).toHaveLength(1);

    (root.querySelector('[data-tag-picker-manage]') as HTMLElement).click();
    expect(wrapper.emitted('manage')).toHaveLength(1);

    root.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true }));
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
