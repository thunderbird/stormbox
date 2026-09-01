// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import {
  defineComponent,
  h,
  nextTick,
  ref,
} from 'vue';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { useModalFocus } from '../../../src/composables/useModalFocus';

describe('useModalFocus', () => {
  it('focuses the neutral modal surface and restores the opener', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const active = ref(true);
    const onDefault = vi.fn();
    const Harness = defineComponent({
      setup() {
        const surface = ref<HTMLElement | null>(null);
        useModalFocus(surface, { active, onDefault });
        return () => h('section', {
          ref: surface,
          'aria-modal': 'true',
          role: 'alertdialog',
          tabindex: -1,
        }, [
          h('button', 'Cancel'),
          h('button', 'Delete'),
        ]);
      },
    });

    const wrapper = mount(Harness, { attachTo: document.body });
    await nextTick();
    await nextTick();

    const dialog = wrapper.get('[role="alertdialog"]').element;
    expect(document.activeElement).toBe(dialog);
    expect(wrapper.findAll('button').some((button) =>
      button.element === document.activeElement)).toBe(false);

    dialog.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    }));
    expect(onDefault).toHaveBeenCalledTimes(1);

    const cancel = wrapper.findAll('button')[0].element as HTMLButtonElement;
    cancel.focus();
    cancel.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    }));
    expect(onDefault).toHaveBeenCalledTimes(1);

    active.value = false;
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(opener);

    wrapper.unmount();
    opener.remove();
  });

  it('contains Tab in the resolved visible controls without taking initial focus', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const useNestedContainer = ref(false);
    const Harness = defineComponent({
      setup() {
        const surface = ref<HTMLElement | null>(null);
        const nested = ref<HTMLElement | null>(null);
        useModalFocus(surface, {
          containTab: true,
          focusOnActivate: false,
          resolveContainer: () => (
            useNestedContainer.value ? nested.value : surface.value
          ),
        });
        return () => h('section', {
          ref: surface,
          role: 'dialog',
          tabindex: -1,
        }, [
          h('details', [
            h('button', { 'data-control': 'closed' }, 'Closed'),
          ]),
          h('button', { 'data-control': 'first' }, 'First'),
          h('button', {
            'aria-hidden': 'true',
            'data-control': 'hidden',
          }, 'Hidden'),
          h('button', { 'data-control': 'last' }, 'Last'),
          h('div', { ref: nested }, [
            h('button', { 'data-control': 'nested-first' }, 'Nested first'),
            h('button', { 'data-control': 'nested-last' }, 'Nested last'),
          ]),
        ]);
      },
    });

    const wrapper = mount(Harness, { attachTo: document.body });
    await nextTick();
    expect(document.activeElement).toBe(opener);

    const first = wrapper.get('[data-control="first"]').element as HTMLButtonElement;
    const nestedLast = wrapper.get('[data-control="nested-last"]').element as HTMLButtonElement;
    nestedLast.focus();
    nestedLast.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Tab',
    }));
    expect(document.activeElement).toBe(first);

    useNestedContainer.value = true;
    await nextTick();
    nestedLast.focus();
    nestedLast.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Tab',
    }));
    expect(document.activeElement)
      .toBe(wrapper.get('[data-control="nested-first"]').element);

    wrapper.unmount();
    opener.remove();
  });

  it('supports a focusable selector override', async () => {
    const Harness = defineComponent({
      setup() {
        const surface = ref<HTMLElement | null>(null);
        useModalFocus(surface, {
          containTab: true,
          focusableSelector: '[data-modal-tab]',
        });
        return () => h('section', { ref: surface, tabindex: -1 }, [
          h('button', 'Excluded'),
          h('button', { 'data-modal-tab': '' }, 'Included'),
        ]);
      },
    });

    const wrapper = mount(Harness, { attachTo: document.body });
    await nextTick();
    const surface = wrapper.get('section').element as HTMLElement;
    surface.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Tab',
    }));

    expect(document.activeElement).toBe(wrapper.findAll('button')[1].element);
    wrapper.unmount();
  });
});
