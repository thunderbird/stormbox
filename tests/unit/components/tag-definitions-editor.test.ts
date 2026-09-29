// @vitest-environment happy-dom

/**
 * The tag manager's editor (specs/011 §6): definitions in order with
 * color, name, immutable keyword and digit; add with a derived-keyword
 * preview; reorder; delete leaves the keyword on messages; keywords found
 * on cached messages can be adopted as tags.
 */

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import TagDefinitionsEditor from '../../../src/components/tags/TagDefinitionsEditor.vue';
import { AUTH_STATE } from '../../../src/constants/states';
import { __setRepositoryForTests } from '../../../src/composables/useRepository';
import { useMessageTags } from '../../../src/composables/useMessageTags';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useMailStore } from '../../../src/stores/mail-store';
import { useSettingsStore } from '../../../src/stores/settings-store';
import { DEFAULT_MESSAGE_TAGS, MAX_TAG_DEFINITIONS } from '../../../src/utils/message-tags';

let keywordsOnMessages: Array<{ keyword: string; count: number }> = [];
let settingsWrites: Array<Record<string, unknown>> = [];

function makeRepo() {
  let settings: Record<string, unknown> = {};
  const doc = () => ({
    doc: {
      owner: 'stormbox', documentType: 'user-settings', version: 1, settings, updatedAt: {},
    },
    remoteNodeId: null,
  });
  return {
    subscribe() { return () => {}; },
    async getSettings() { return doc(); },
    async applySettingsPatch(_accountId: number, patch: Record<string, unknown>) {
      const snapshot = structuredClone(patch);
      settingsWrites.push(snapshot);
      settings = { ...settings, ...snapshot };
      return doc();
    },
    async listMessageKeywords() { return keywordsOnMessages; },
    async insertPendingMutation() { return { id: 1 }; },
  };
}

const mounted: Array<{ unmount: () => void }> = [];

async function mountSection() {
  const wrapper = mount(TagDefinitionsEditor, { attachTo: document.body, props: { labelledBy: 'tags-title' } });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

function tagKeywords(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('[data-tag-setting]').map((li) => li.attributes('data-tag-setting'));
}

beforeEach(async () => {
  setActivePinia(createPinia());
  window.localStorage?.clear();
  __setRepositoryForTests(makeRepo() as any);
  useAuthStore().accountId = 1;
  useAuthStore().status = AUTH_STATE.CONNECTED;
  const mailStore = useMailStore() as any;
  mailStore.accounts = [{ id: 1 }, { id: 2 }];
  await useSettingsStore().attach();
  await flushPromises();
  keywordsOnMessages = [];
  settingsWrites = [];
});

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  vi.restoreAllMocks();
});

describe('TagDefinitionsEditor', () => {
  it('lets IME confirmation finish without cancelling Enter or submitting early', async () => {
    const wrapper = await mountSection();
    const input = wrapper.find('[data-tag-editor-name]');
    await input.setValue('日本語');
    await input.trigger('compositionstart');
    const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    input.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(settingsWrites).toHaveLength(0);
    await input.trigger('compositionend');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect((settingsWrites.at(-1)?.messageTags as any[]).at(-1).name).toBe('日本語');
  });

  it('requires an explicit display name for long imported keywords without losing existing tags', async () => {
    for (const length of [101, 129, 255]) {
      const keyword = 'x'.repeat(length);
      keywordsOnMessages = [{ keyword, count: 1 }];
      const wrapper = await mountSection();
      await wrapper.find('[data-tag-editor-adopt]').trigger('click');
      await flushPromises();
      expect(wrapper.find('#tag-editor-name-help').text()).toBe('Use 100 characters or fewer.');
      expect(wrapper.find('[data-tag-editor-submit]').attributes('disabled')).toBeDefined();
      const previous = useSettingsStore().get('messageTags');
      await wrapper.find('[data-tag-editor-name]').setValue(`Imported ${length}`);
      await wrapper.find('form').trigger('submit');
      await flushPromises();
      const tags = useSettingsStore().get('messageTags');
      expect(tags).toEqual([...previous, { keyword, name: `Imported ${length}`, color: tags.at(-1)!.color, order: previous.length }]);
      expect(settingsWrites.at(-1)?.messageTags).toEqual(tags);
      wrapper.unmount();
    }
    const before = settingsWrites.length;
    await expect(useMessageTags().defineKeyword('x'.repeat(256), 'Invalid')).resolves.toBeNull();
    expect(settingsWrites).toHaveLength(before);
  });
  it('saves Unicode names intact and explains invalid names without truncating them', async () => {
    const wrapper = await mountSection();
    const input = wrapper.find('[data-tag-editor-name]');
    await input.setValue('日本語');
    expect(wrapper.find('[data-tag-editor-submit]').attributes('disabled')).toBeUndefined();
    await wrapper.find('[data-tag-editor-add]').trigger('submit');
    await flushPromises();
    expect(useSettingsStore().get('messageTags').at(-1)?.name).toBe('日本語');
    expect((input.element as HTMLInputElement).value).toBe('');
    expect(wrapper.find('.tag-editor__status').text()).toBe('');
    expect(settingsWrites.at(-1)?.messageTags).toEqual(useSettingsStore().get('messageTags'));
    await input.setValue('😀'.repeat(101));
    expect(wrapper.find('[data-tag-editor-submit]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('#tag-editor-name-help').text()).toBe('Use 100 characters or fewer.');
    const rename = wrapper.find('[data-tag-setting="$label2"] .tag-editor__name');
    await rename.setValue('語'.repeat(101));
    await rename.trigger('blur');
    expect(useSettingsStore().get('messageTags')[1].name).toBe('Work');
    expect(rename.attributes('aria-invalid')).toBe('true');
  });
  it('lists the definitions in order with their keyword and digit, and the count against the cap', async () => {
    const wrapper = await mountSection();
    expect(tagKeywords(wrapper)).toEqual(DEFAULT_MESSAGE_TAGS.map((d) => d.keyword));
    const first = wrapper.find('[data-tag-setting="$label1"]');
    expect((first.find('.tag-editor__name').element as HTMLInputElement).value).toBe('Important');
    expect(first.find('.tag-editor__keyword').text()).toBe('Keyword $label1');
    expect(first.find('.tag-editor__digit').text()).toBe('Press 1 to toggle');
    expect(wrapper.find('.tag-editor__count').text()).toBe(`5 of ${MAX_TAG_DEFINITIONS}`);
  });

  it('puts the New Tag form above the list', async () => {
    const wrapper = await mountSection();
    const form = wrapper.find('[data-tag-editor-add]').element;
    const list = wrapper.find('.tag-editor__list').element;
    expect(form.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(wrapper.find('[data-tag-editor-submit]').text()).toBe('New Tag');
  });

  it('adds a tag with a keyword derived from the name and a random unused palette color', async () => {
    // With the five defaults, the unused colors start at #0099CC.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const wrapper = await mountSection();
    const name = wrapper.find('[data-tag-editor-name]');
    expect(wrapper.find('[data-tag-editor-submit]').attributes('disabled')).toBeDefined();

    await name.setValue('Tax Receipts (2026)');
    expect(wrapper.find('[data-tag-editor-add] .tag-editor__keyword').text()).toBe('Keyword tax=20receipts=20=282026=29');
    await wrapper.find('[data-tag-editor-add]').trigger('submit');
    await flushPromises();

    const tags = useSettingsStore().get('messageTags');
    expect(tags.at(-1)).toEqual({
      keyword: 'tax=20receipts=20=282026=29', name: 'Tax Receipts (2026)', color: '#0099CC', order: 5,
    });
    expect(tagKeywords(wrapper).at(-1)).toBe('tax=20receipts=20=282026=29');
    expect((name.element as HTMLInputElement).value).toBe('');
    expect(settingsWrites.at(-1)?.messageTags).toEqual(tags);
  });

  it('renames and recolors without touching the keyword, reorders, and deletes the definition only', async () => {
    const wrapper = await mountSection();
    const work = wrapper.find('[data-tag-setting="$label2"]');

    const nameInput = work.find('.tag-editor__name');
    await nameInput.setValue('Office');
    await nameInput.trigger('blur');
    await flushPromises();
    expect(useSettingsStore().get('messageTags')[1]).toMatchObject({ keyword: '$label2', name: 'Office' });
    expect(settingsWrites.at(-1)?.messageTags).toEqual(useSettingsStore().get('messageTags'));

    await work.find('.tag-editor__color').setValue('#123456');
    await work.find('.tag-editor__color').trigger('change');
    await flushPromises();
    expect(useSettingsStore().get('messageTags')[1].color).toBe('#123456');
    expect(settingsWrites.at(-1)?.messageTags).toEqual(useSettingsStore().get('messageTags'));

    await work.find('[aria-label="Move Office up"]').trigger('click');
    await flushPromises();
    expect(useSettingsStore().get('messageTags').slice(0, 2).map((d) => [d.keyword, d.order]))
      .toEqual([['$label2', 0], ['$label1', 1]]);
    expect(tagKeywords(wrapper).slice(0, 2)).toEqual(['$label2', '$label1']);
    expect(settingsWrites.at(-1)?.messageTags).toEqual(useSettingsStore().get('messageTags'));

    await wrapper.find('[aria-label="Delete tag Office"]').trigger('click');
    await flushPromises();
    expect(tagKeywords(wrapper)).toEqual(['$label1', '$label3', '$label4', '$label5']);
    expect(useSettingsStore().get('messageTags').map((d) => d.order)).toEqual([0, 1, 2, 3]);
    expect(settingsWrites.at(-1)?.messageTags).toEqual(useSettingsStore().get('messageTags'));
  });

  it('offers keywords found on messages that no tag names, and adopts one as-is', async () => {
    keywordsOnMessages = [
      { keyword: '$seen', count: 40 },
      { keyword: 'NonJunk', count: 30 },
      { keyword: '$muted', count: 20 },
      { keyword: '$label2', count: 3 },
      { keyword: 'receipts', count: 2 },
      { keyword: 'Newsletter', count: 1 },
    ];
    const wrapper = await mountSection();

    const discovered = wrapper.find('[data-tag-editor-discovered]');
    expect(discovered.findAll('.tag-editor__keyword').map((code) => code.text()))
      .toEqual(['receipts', 'Newsletter']);

    await wrapper.find('[data-tag-editor-adopt="Newsletter"]').trigger('click');
    await flushPromises();
    // The keyword is normalized; the name keeps the spelling the other client used.
    expect(useSettingsStore().get('messageTags').at(-1)).toMatchObject({
      keyword: 'newsletter', name: 'Newsletter', order: 5,
    });
    expect(discovered.findAll('.tag-editor__keyword').map((code) => code.text())).toEqual(['receipts']);
  });

  it('defines a hidden system keyword only when the typed name spells it exactly', async () => {
    const wrapper = await mountSection();
    await wrapper.find('[data-tag-editor-name]').setValue('$Todo');
    expect(wrapper.find('#tag-editor-new-keyword').text()).toBe('Keyword $todo');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(useSettingsStore().get('messageTags').at(-1)).toMatchObject({ keyword: '$todo', name: '$Todo' });
    expect(tagKeywords(wrapper).at(-1)).toBe('$todo');
  });
});
