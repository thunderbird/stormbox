// @vitest-environment happy-dom

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h, nextTick } from 'vue';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import { VueDatePicker } from '@vuepic/vue-datepicker';

import ScheduleSendDialog from '../../../src/components/ScheduleSendDialog.vue';
import { useSettingsStore } from '../../../src/stores/settings-store';

const PickerStub = defineComponent({
  name: 'VueDatePicker',
  props: {
    modelValue: { type: null, default: null },
    minDate: { type: null, default: null },
    maxDate: { type: null, default: null },
  },
  emits: [
    'update:model-value',
    'open',
    'closed',
    'internal-model-change',
    'invalid-date',
    'invalid-select',
  ],
  setup(_props, { emit }) {
    return () => h('div', {
      class: 'picker-stub',
      onClick: () => emit('open'),
    });
  },
});

const mountedWrappers: Array<{ unmount: () => void }> = [];

function mountScheduleDialog(
  clock = { value: Date.parse('2026-03-01T12:00:00Z') },
) {
  vi.spyOn(Date, 'now').mockImplementation(() => clock.value);
  useSettingsStore().settings = { timeZone: 'America/New_York' };
  const wrapper = mount(ScheduleSendDialog, {
    attachTo: document.body,
    props: {
      busy: false,
      maxDelayedSend: 30 * 24 * 60 * 60,
      serverClockReference: null,
      sessionId: 'session-1',
      timeZone: 'America/New_York',
    },
    global: {
      stubs: { teleport: true, VueDatePicker: PickerStub },
    },
  });
  mountedWrappers.push(wrapper);
  return wrapper;
}

async function emitPickerEvent(
  wrapper: ReturnType<typeof mountScheduleDialog>,
  event: 'open' | 'closed' | 'internal-model-change' | 'invalid-date' | 'invalid-select',
  payload?: unknown,
) {
  const picker = wrapper.findComponent(VueDatePicker);
  if (payload === undefined) {
    await picker.vm.$emit(event);
  } else {
    await picker.vm.$emit(event, payload);
  }
  await flushPromises();
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ScheduleSendDialog picker validation', () => {
  it('advances picker bounds while the dialog remains open', async () => {
    vi.useFakeTimers();
    const clock = { value: Date.parse('2026-03-01T12:00:00Z') };
    const wrapper = mountScheduleDialog(clock);
    const picker = wrapper.findComponent(VueDatePicker);
    expect(picker.props('minDate')).toBe('2026-03-01T07:00:00.000Z');

    clock.value = Date.parse('2026-03-01T13:00:00Z');
    expect(vi.getTimerCount()).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await nextTick();

    expect(wrapper.findComponent(VueDatePicker).props('minDate'))
      .toBe('2026-03-01T08:00:00.000Z');
  });

  it('shows provisional past-time validation from internal picker changes', async () => {
    const wrapper = mountScheduleDialog();

    await emitPickerEvent(wrapper, 'open');
    await emitPickerEvent(wrapper, 'internal-model-change', '2026-02-28T12:00:00.000Z');

    expect(wrapper.get('.schedule-dialog__error').attributes('role')).toBe('alert');
    expect(wrapper.get('.schedule-dialog__error').text())
      .toBe('Choose a scheduled time in the future.');
    expect(wrapper.find('.schedule-dialog__resolved').exists()).toBe(false);
  });

  it('clears provisional validation when the internal picker value becomes valid', async () => {
    const wrapper = mountScheduleDialog();

    await emitPickerEvent(wrapper, 'open');
    await emitPickerEvent(wrapper, 'internal-model-change', '2026-03-05T09:30:00.000Z');

    expect(wrapper.find('.schedule-dialog__error').exists()).toBe(false);
    expect(wrapper.get('.schedule-dialog__resolved').text()).toMatch(/^Sends /);
  });

  it('clears provisional validation when the picker popup closes', async () => {
    const wrapper = mountScheduleDialog();

    await emitPickerEvent(wrapper, 'open');
    await emitPickerEvent(wrapper, 'internal-model-change', '2026-02-28T12:00:00.000Z');
    await emitPickerEvent(wrapper, 'closed');

    expect(wrapper.find('.schedule-dialog__error').exists()).toBe(false);
    expect(wrapper.get('.schedule-dialog__resolved').text()).toMatch(/^Sends /);
  });

  it('shows invalid-date feedback without mutating the committed picker value', async () => {
    const wrapper = mountScheduleDialog();
    const committed = wrapper.findComponent(VueDatePicker).props('modelValue');

    await emitPickerEvent(wrapper, 'open');
    await emitPickerEvent(wrapper, 'invalid-date', new Date('2026-02-28T12:00:00.000Z'));

    expect(wrapper.get('.schedule-dialog__error').text())
      .toBe('Choose a scheduled time in the future.');
    expect(wrapper.find('.schedule-dialog__resolved').exists()).toBe(false);
    expect(wrapper.findComponent(VueDatePicker).props('modelValue')).toBe(committed);

    await emitPickerEvent(wrapper, 'closed');

    expect(wrapper.find('.schedule-dialog__error').exists()).toBe(false);
    expect(wrapper.findComponent(VueDatePicker).props('modelValue')).toBe(committed);
  });

  it('stands down dialog Escape while the date picker popup is open', async () => {
    const wrapper = mountScheduleDialog();

    await emitPickerEvent(wrapper, 'open');
    await wrapper.get('.schedule-dialog').trigger('keydown', { key: 'Escape' });
    await nextTick();

    expect(wrapper.find('.schedule-dialog').exists()).toBe(true);

    await emitPickerEvent(wrapper, 'closed');
    await wrapper.get('.schedule-dialog').trigger('keydown', { key: 'Escape' });
    await flushPromises();

    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('contains Tab while leaving picker Escape handling local', async () => {
    const wrapper = mountScheduleDialog();
    await nextTick();
    const close = wrapper.get('.schedule-dialog__close').element as HTMLButtonElement;
    const submit = wrapper.get('.schedule-dialog__submit').element as HTMLButtonElement;

    submit.focus();
    submit.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Tab',
    }));
    expect(document.activeElement).toBe(close);

    close.focus();
    close.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Tab',
      shiftKey: true,
    }));
    expect(document.activeElement).toBe(submit);
  });
});
