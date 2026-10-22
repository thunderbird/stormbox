// @vitest-environment happy-dom

import { enableAutoUnmount, mount } from '@vue/test-utils';
import {
  defineComponent,
  h,
  nextTick,
  ref,
} from 'vue';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { useModalFocus } from '../../../src/composables/useModalFocus';

enableAutoUnmount(afterEach);
afterEach(() => { document.body.innerHTML = ''; });

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

  it('isolates nested teleported modals and restores each live opener', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const Modal = defineComponent({
      setup() {
        const surface = ref<HTMLElement | null>(null);
        useModalFocus(surface, { containTab: true });
        return () => h('section', {
          ref: surface, tabindex: -1, role: 'dialog', 'aria-modal': 'true',
        }, [h('button', 'Open next')]);
      },
    });
    const first = mount(Modal, { attachTo: document.body });
    await nextTick();
    await nextTick();
    const firstButton = first.get('button').element as HTMLButtonElement;
    firstButton.focus();
    const second = mount(Modal, { attachTo: document.body });
    await nextTick();
    await nextTick();
    expect(first.element.closest('[inert]')).not.toBeNull();
    expect(opener.hasAttribute('inert')).toBe(true);
    second.unmount();
    await nextTick();
    expect(first.element.closest('[inert]')).toBeNull();
    expect(document.activeElement).toBe(firstButton);
    expect(opener.hasAttribute('inert')).toBe(true);
    first.unmount();
    await nextTick();
    expect(opener.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('cancels activation if the dialog closes before the next render', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const Harness = defineComponent({
      setup() {
        const surface = ref<HTMLElement | null>(null);
        useModalFocus(surface, { containTab: true });
        return () => h('section', {
          ref: surface, tabindex: -1, role: 'dialog', 'aria-modal': 'true',
        });
      },
    });
    const wrapper = mount(Harness, { attachTo: document.body });
    wrapper.unmount();
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(opener);
    expect(opener.hasAttribute('inert')).toBe(false);
  });
});
