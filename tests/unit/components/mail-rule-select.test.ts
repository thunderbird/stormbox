// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import MailRuleSelect from '../../../src/components/MailRuleSelect.vue';

const options = [
  { value: 'all', label: 'All conditions' },
  { value: 'disabled', label: 'Unavailable', disabled: true },
  { value: 'any', label: 'Any condition' },
];

describe('MailRuleSelect', () => {
  it('supports menu keyboard navigation and restores summary focus after selection', async () => {
    const wrapper = mount(MailRuleSelect, {
      attachTo: document.body,
      props: {
        modelValue: 'all',
        options,
        controlLabel: 'Condition mode',
      },
    });
    const summary = wrapper.get('summary');

    await summary.trigger('keydown', { key: 'ArrowDown' });
    await nextTick();
    expect((document.activeElement as HTMLElement).dataset.ruleOption).toBe('all');

    const allOption = wrapper.get('[data-rule-option="all"]');
    await allOption.trigger('keydown', { key: 'ArrowDown' });
    expect((document.activeElement as HTMLElement).dataset.ruleOption).toBe('any');

    const anyOption = wrapper.get('[data-rule-option="any"]');
    await anyOption.trigger('keydown', { key: 'ArrowDown' });
    expect((document.activeElement as HTMLElement).dataset.ruleOption).toBe('all');

    await allOption.trigger('keydown', { key: 'End' });
    expect((document.activeElement as HTMLElement).dataset.ruleOption).toBe('any');
    await anyOption.trigger('keydown', { key: 'Home' });
    expect((document.activeElement as HTMLElement).dataset.ruleOption).toBe('all');

    await anyOption.trigger('click');
    expect(wrapper.emitted('update:modelValue')).toEqual([['any']]);
    expect(document.activeElement).toBe(summary.element);
    expect(wrapper.get('details').attributes('open')).toBeUndefined();

    wrapper.unmount();
  });

  it('opens upward from the summary and focuses the last enabled option', async () => {
    const wrapper = mount(MailRuleSelect, {
      attachTo: document.body,
      props: {
        modelValue: 'all',
        options,
        controlLabel: 'Condition mode',
      },
    });

    await wrapper.get('summary').trigger('keydown', { key: 'ArrowUp' });
    await nextTick();
    expect((document.activeElement as HTMLElement).dataset.ruleOption).toBe('any');

    wrapper.unmount();
  });

  it('does not reopen from retained focus after becoming disabled', async () => {
    const wrapper = mount(MailRuleSelect, {
      attachTo: document.body,
      props: {
        modelValue: 'all',
        options,
        controlLabel: 'Condition mode',
      },
    });
    const summary = wrapper.get('summary');
    (summary.element as HTMLElement).focus();
    await wrapper.setProps({ disabled: true });

    await summary.trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.get('details').attributes('open')).toBeUndefined();

    wrapper.unmount();
  });
});
