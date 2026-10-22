// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { VueDatePicker } from '@vuepic/vue-datepicker';
import ScheduleSendDialog from '../../../src/components/ScheduleSendDialog.vue';

const PickerStub = defineComponent({
  name: 'VueDatePicker',
  props: ['modelValue', 'minDate', 'maxDate', 'inline', 'autoApply', 'timeConfig'],
  emits: ['update:model-value', 'internal-model-change', 'invalid-date', 'invalid-select'],
  setup() { return () => h('div', { class: 'picker-stub' }); },
});
enableAutoUnmount(afterEach);
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function mountDialog(clock = { value: Date.parse('2026-03-01T12:00:00Z') }) {
  vi.spyOn(Date, 'now').mockImplementation(() => clock.value);
  return mount(ScheduleSendDialog, {
    attachTo: document.body,
    props: {
      busy: false, maxDelayedSend: 30 * 24 * 60 * 60,
      serverClockReference: null, sessionId: 'session-1', timeZone: 'America/New_York',
    },
    global: { stubs: { teleport: true, VueDatePicker: PickerStub } },
  });
}
async function change(wrapper: ReturnType<typeof mountDialog>, event: string, value: unknown) {
  wrapper.findComponent(VueDatePicker).vm.$emit(event, value);
  await flushPromises();
}

describe('ScheduleSendDialog', () => {
  it('opens the calendar and time controls inline with one confirmation', () => {
    const wrapper = mountDialog();
    const picker = wrapper.findComponent(VueDatePicker);
    expect(picker.props('inline')).not.toBeUndefined();
    expect(picker.props('autoApply')).not.toBeUndefined();
    expect(picker.props('timeConfig').timePickerInline).toBe(true);
    expect(wrapper.find('[aria-label="Search time zones"]').exists()).toBe(false);
    expect(wrapper.get('.schedule-dialog__submit').text()).toBe('Set send time');
  });
  it('advances picker bounds while open', async () => {
    vi.useFakeTimers();
    const clock = { value: Date.parse('2026-03-01T12:00:00Z') };
    const wrapper = mountDialog(clock);
    expect(wrapper.findComponent(VueDatePicker).props('minDate')).toBe('2026-03-01T07:00:00.000Z');
    clock.value += 3_600_000;
    await vi.advanceTimersByTimeAsync(30_000);
    await nextTick();
    expect(wrapper.findComponent(VueDatePicker).props('minDate')).toBe('2026-03-01T08:00:00.000Z');
  });
  it('rejects an invalid internal value instead of confirming the previous selection', async () => {
    const wrapper = mountDialog();
    await change(wrapper, 'internal-model-change', new Date('2026-02-28T12:00:00Z'));
    expect(wrapper.get('[role="alert"]').text()).toBe('Choose a scheduled time in the future.');
    expect(wrapper.get('.schedule-dialog__submit').attributes('disabled')).toBeDefined();
    await wrapper.get('.schedule-dialog').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('select')).toBeUndefined();
  });
  it('confirms the visible internal selection without an inner Apply action', async () => {
    const wrapper = mountDialog();
    await change(wrapper, 'internal-model-change', new Date('2026-03-05T09:30:00Z'));
    await wrapper.get('.schedule-dialog__submit').trigger('click');
    expect(wrapper.emitted('select')).toEqual([['2026-03-05T14:30:00.000Z', 'America/New_York']]);
  });
  it('re-resolves the same wall time when the setting changes', async () => {
    const wrapper = mountDialog();
    await change(wrapper, 'update:model-value', '2026-03-05T09:30:00.000Z');
    await wrapper.setProps({ timeZone: 'Asia/Tokyo' });
    await wrapper.get('.schedule-dialog__submit').trigger('click');
    expect(wrapper.emitted('select')).toEqual([['2026-03-05T00:30:00.000Z', 'Asia/Tokyo']]);
  });
  it('clears rejected-date feedback on a valid selection', async () => {
    const wrapper = mountDialog();
    await change(wrapper, 'invalid-date', new Date('2026-02-28T12:00:00Z'));
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    await change(wrapper, 'update:model-value', '2026-03-05T09:30:00.000Z');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('[role="status"]').text()).toMatch(/^Sends /);
  });
  it('Escape closes the inline picker, while busy prevents closing and confirmation', async () => {
    const wrapper = mountDialog();
    await wrapper.setProps({ busy: true });
    await wrapper.get('.schedule-dialog').trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('close')).toBeUndefined();
    await wrapper.setProps({ busy: false });
    await wrapper.get('.schedule-dialog').trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
