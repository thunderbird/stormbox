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
});
