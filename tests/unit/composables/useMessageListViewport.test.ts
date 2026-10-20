// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import {
  computed, defineComponent, h, nextTick, ref, shallowRef,
} from 'vue';
import type { Virtualizer } from '@tanstack/vue-virtual';

import type { CachedRow } from '../../../src/stores/mail-store-types';

const instances: Virtualizer<Element, Element>[] = [];

vi.mock('../../../src/stores/mail-store', () => ({
  useMailStore: () => ({ folderPickCount: 0 }),
}));

// Supply geometry to the real adapter and virtual-core in happy-dom.
vi.mock('@tanstack/vue-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/vue-virtual')>();
  return {
    ...actual,
    useVirtualizer: (options) => {
      const result = actual.useVirtualizer(computed(() => ({
        ...options.value,
        initialRect: { width: 600, height: 640 },
        initialOffset: 40 * 64,
      })));
      instances.push(result.value);
      return result;
    },
  };
});

import { useMessageListViewport } from '../../../src/composables/useMessageListViewport';

function rows(start: number, count: number): CachedRow[] {
  return Array.from({ length: count }, (_, index) => ({ id: start + index } as CachedRow));
}

const wrappers: ReturnType<typeof mount>[] = [];

function setup(initialRows: CachedRow[]) {
  const visibleMessages = shallowRef(initialRows);
  const wrapper = mount(defineComponent({
    setup() {
      useMessageListViewport({
        listEl: ref(null),
        folderId: ref(null),
        primary: ref(true),
        visibleMessages,
        rowCount: ref(200),
        denseFilterActive: ref(true),
        focusedMessageId: ref(null),
      });
      return () => h('div');
    },
  }));
  wrappers.push(wrapper);
  return { visibleMessages, virtualizer: instances.at(-1)! };
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  instances.length = 0;
});

describe('useMessageListViewport row identity', () => {
  it('keeps every key aligned with its row after a same-count shift and upward scroll', async () => {
    const { visibleMessages, virtualizer } = setup(rows(1000, 200));
    expect(virtualizer.getVirtualItems().length).toBeGreaterThan(0);

    visibleMessages.value = rows(1010, 200);
    await nextTick();
    virtualizer.scrollOffset = 34 * 64;
    const items = virtualizer.getVirtualItems();

    expect(items.map((item) => item.key)).toEqual(
      items.map((item) => visibleMessages.value[item.index]?.id),
    );
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });

  it('replaces placeholder keys when a page fills without changing the total', async () => {
    const { visibleMessages, virtualizer } = setup([]);
    expect(virtualizer.getVirtualItems().every((item) => String(item.key).startsWith('_ph_'))).toBe(true);

    visibleMessages.value = rows(1000, 100);
    await nextTick();
    const items = virtualizer.getVirtualItems();

    expect(items.map((item) => item.key)).toEqual(
      items.map((item) => visibleMessages.value[item.index]?.id),
    );
  });
});
