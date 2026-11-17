// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { computed, defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { i18n } from '../../../src/i18n';
import { errorDescription, errorMessage, LocalizedError, sourceText, t } from '../../../src/i18n/messages';
import { pluralRule } from '../../../src/i18n/plurals';
import { serializeRpcError } from '../../../src/db/rpc-dispatch';
import { FEATURE_CARDS } from '../../../src/constants/feature-tour';
import RichTextEditor from '../../../src/components/RichTextEditor.vue';
import TagPickerPanel from '../../../src/components/TagPickerPanel.vue';
import { senderAvatarStyle } from '../../../src/utils/sender-avatar';
import { formatQuotedHeader } from '../../../src/utils/compose-quote';
import { formatScheduleTarget, wallTimeToUtc } from '../../../src/utils/schedule-time';

function useTestCatalog() {
  i18n.global.setLocaleMessage('de', {
    common: { language: 'Sprache' },
    featureTour: { composeWithConfidence: 'Sicher schreiben' },
    senderAvatar: { hsl4242: 'INVALID CSS' },
    tagPickerPanel: { tags: 'Schlagwörter' },
    richTextEditor: { richTextEditor: 'Nachrichtentext', bold: 'Fett', b: 'INVALID', resizeObserver: 'INVALID' },
    fixture: { parameter: 'Nachricht von {sender}' },
    repository: { databaseConnectionClosed: 'Datenbankverbindung geschlossen.' },
  });
  i18n.global.locale.value = 'de';
}
afterEach(() => { i18n.global.locale.value = 'en'; });

describe('localization', () => {
  it('preserves the original English wording and numeric interpolation', () => {
    expect(t('scheduleTime.chooseATimeWithinSeconds', { value1: 2592000 }))
      .toBe('Choose a time within 2592000 seconds.');
    expect(t('folderManagerDialog.itContainsMessagePlural', { arg1: 1, arg2: 1 }, 1)).toBe('It contains 1 message.');
    expect(t('folderManagerDialog.theyContainMessages', { arg1: 1500, arg2: 1500 }, 1500)).toBe('They contain 1500 messages.');
    expect(t('restoreContactDestinationDialog.chooseDestination', {}, 2))
      .toBe('These contacts have no original writable address book. Choose where to restore them.');
  });

  it('updates computed labels through Vue I18n and falls back per message', () => {
    const card = computed(() => FEATURE_CARDS[0].title);
    useTestCatalog();
    expect(card.value).toBe('Sicher schreiben');
    expect(t('common.fromHeader', { value: 'Ada' })).toBe('From: Ada');
    i18n.global.locale.value = 'en';
    expect(card.value).toBe('Compose with confidence');
  });

  it('supports the plural categories without changing supplied numbers', () => {
    const rule = pluralRule('ar');
    expect([0, 1, 2, 3, 11, 100].map((n) => rule(n, 6))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(t('bulkOperationOverlay.itemCount', { count: '1,234', item: 'messages' })).toBe('1,234 messages');
    expect(t('selectableListHeader.itemCount', { count: 1234, item: 'messages' })).toBe('1234 messages');
  });

  it('renders interpolated data as text and preserves localizable RPC errors', () => {
    useTestCatalog();
    const input = '<img src=x onerror=alert(1)>';
    const wrapper = mount(defineComponent(() => () => h('p', t('fixture.parameter', { sender: input }))));
    expect(wrapper.text()).toBe(`Nachricht von ${input}`);
    expect(wrapper.find('img').exists()).toBe(false);
    const error = new LocalizedError('repository.databaseConnectionClosed');
    const wire = JSON.parse(JSON.stringify(serializeRpcError(error)));
    expect(wire.messageKey).toBe('repository.databaseConnectionClosed');
    expect(errorMessage(wire)).toBe('Datenbankverbindung geschlossen.');
    expect(sourceText('repository.databaseConnectionClosed')).toBe('Database connection closed.');
    expect(errorDescription({ message: 'Internal diagnostic' })).toBeNull();
    expect(errorDescription({ description: 'Server description' })).toBe('Server description');
    wrapper.unmount();
  });

  it('updates mounted text without translating editor DOM tags or CSS', async () => {
    const tags = mount(TagPickerPanel, { props: { targets: [], definitions: [] } });
    const editor = mount(RichTextEditor, { attachTo: document.body, props: { initialHtml: '<div>hello</div>', contentKey: 'localization' } });
    try {
      expect(tags.attributes('aria-label')).toBe('Tags');
      useTestCatalog();
      await nextTick();
      expect(tags.attributes('aria-label')).toBe('Schlagwörter');
      const body = editor.get('[contenteditable="true"]');
      expect(body.attributes('aria-label')).toBe('Nachrichtentext');
      const range = document.createRange();
      range.selectNodeContents(body.element);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      body.element.dispatchEvent(new Event('mouseup', { bubbles: true }));
      await editor.get('[aria-label="Fett"]').trigger('click');
      expect(body.element.querySelector('b, strong')).not.toBeNull();
      expect(body.element.querySelector('invalid')).toBeNull();
      expect(senderAvatarStyle('Ada').background).toMatch(/^hsl\(\d+ 42% 42%\)$/);
    } finally { tags.unmount(); editor.unmount(); }
  });

  it('keeps existing date formats and scheduling arithmetic independent of translations', () => {
    const timestamp = Date.UTC(2026, 9, 28, 12);
    const target = formatScheduleTarget(timestamp, 'UTC');
    const before = wallTimeToUtc({ year: 2026, month: 10, day: 28, hour: 12, minute: 0 }, 'Europe/Berlin');
    useTestCatalog();
    expect(formatQuotedHeader({ date: timestamp })).toBe(`Date: ${new Date(timestamp).toLocaleString()}`);
    expect(formatScheduleTarget(timestamp, 'UTC')).toBe(target);
    expect(wallTimeToUtc({ year: 2026, month: 10, day: 28, hour: 12, minute: 0 }, 'Europe/Berlin')).toEqual(before);
  });
});
