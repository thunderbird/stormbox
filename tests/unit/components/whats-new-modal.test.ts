// @vitest-environment happy-dom

import {
  afterEach, describe, expect, it,
} from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import WhatsNewModal from '../../../src/components/WhatsNewModal.vue';
import { FEATURE_CARDS } from '../../../src/constants/feature-tour';

const mounted: Array<ReturnType<typeof mount>> = [];

function mountModal(props: Record<string, unknown> = {}) {
  const wrapper = mount(WhatsNewModal, {
    attachTo: document.body,
    props: { activeSpotlight: null, ...props },
  });
  mounted.push(wrapper);
  return wrapper;
}

function pressEscape() {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'Escape',
  }));
}

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

describe('WhatsNewModal', () => {
  it('renders the compact announcement with every feature card and a Show me button', () => {
    const wrapper = mountModal();

    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.attributes('aria-modal')).toBe('true');
    expect(dialog.attributes('aria-labelledby')).toBe('whats-new-title');
    expect(wrapper.get('#whats-new-title').text()).toBe("What's new in Thundermail");
    expect(wrapper.findAll('.feature-card h3').map((heading) => heading.text()))
      .toEqual(FEATURE_CARDS.map((card) => card.title));
    expect(wrapper.findAll('.feature-card__show').map((button) => button.attributes('aria-label')))
      .toEqual(FEATURE_CARDS.map((card) => `Show me: ${card.title}`));
    expect(wrapper.text()).not.toContain('Keyboard Shortcuts');
    expect(wrapper.find('.whats-new__logo').exists()).toBe(false);
    expect(wrapper.get('.whats-new__primary').text()).toBe('Got it');
  });

  it('emits spotlight for the clicked card and dismiss from Got it, the close button, and Escape', async () => {
    const wrapper = mountModal();

    await wrapper.get('button[aria-label="Show me: Send on your schedule"]').trigger('click');
    expect(wrapper.emitted('spotlight')).toEqual([['sendLater']]);

    await wrapper.get('.whats-new__primary').trigger('click');
    await wrapper.get('.whats-new__close').trigger('click');
    expect(wrapper.emitted('dismiss')).toHaveLength(2);

    pressEscape();
    await nextTick();
    expect(wrapper.emitted('dismiss')).toHaveLength(3);
  });

  it('hides the panel behind the caption while a spotlight runs and lets Done cancel it', async () => {
    const wrapper = mountModal({ activeSpotlight: 'contacts' });

    expect(wrapper.find('.whats-new--spotlighting').exists()).toBe(true);
    expect(wrapper.find('.feature-card--active').text()).toContain('Contacts and identities');
    expect(wrapper.findAll('.feature-card__show').every((button) => button.attributes('disabled') != null))
      .toBe(true);
    const caption = wrapper.get('[data-testid="feature-caption"]');
    expect(caption.attributes('aria-label')).toBe('Showing: Contacts and identities');
    expect(caption.text()).toContain('Contacts and identities');
    // Without step progress the caption falls back to the card description.
    expect(caption.text()).toContain('Manage address books');
    expect(caption.find('.feature-caption__steps').exists()).toBe(false);

    // With progress it narrates the current step and shows where it is.
    await wrapper.setProps({ progress: { caption: 'Contacts live in the rail.', index: 1, count: 2 } });
    expect(caption.get('.feature-caption__body').text()).toBe('Contacts live in the rail.');
    expect(caption.get('.feature-caption__steps').attributes('aria-label')).toBe('Step 2 of 2');
    expect(caption.findAll('.feature-caption__steps li.is-current')).toHaveLength(1);

    // Escape belongs to the spotlight controller while one is running.
    pressEscape();
    await nextTick();
    expect(wrapper.emitted('dismiss')).toBeUndefined();

    await caption.get('.feature-caption__done').trigger('click');
    expect(wrapper.emitted('cancelSpotlight')).toHaveLength(1);

    await wrapper.setProps({ activeSpotlight: null });
    expect(wrapper.find('.whats-new--spotlighting').exists()).toBe(false);
    expect(wrapper.find('[data-testid="feature-caption"]').exists()).toBe(false);
  });

  it('moves focus onto Done during a spotlight and back to the Show me button afterwards', async () => {
    const wrapper = mountModal();

    const showMe = wrapper.get('button[aria-label="Show me: Organize your mail"]');
    (showMe.element as HTMLButtonElement).focus();
    await wrapper.setProps({ activeSpotlight: 'folders' });
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(wrapper.get('.feature-caption__done').element);

    await wrapper.setProps({ activeSpotlight: null });
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(showMe.element);
  });

  it('marks reduced motion on the root and the card grid', () => {
    const wrapper = mountModal({ reducedMotion: true });

    expect(wrapper.find('.whats-new--reduced-motion').exists()).toBe(true);
    expect(wrapper.find('.feature-tour--reduced-motion').exists()).toBe(true);
  });
});
