// @vitest-environment happy-dom

import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import MailRulesDialog from '../../../src/components/MailRulesDialog.vue';
import {
  __resetRepositoryForTests,
  __setRepositoryForTests,
} from '../../../src/composables/useRepository';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useMailStore } from '../../../src/stores/mail-store';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    supported: true,
    accountId: 'remote-1',
    state: 'sieve-state-1',
    capabilities: {
      sieveExtensions: ['copy', 'fileinto', 'imap4flags', 'mailboxid'],
      maxSizeScript: 64_000,
      maxNumberRedirects: 4,
    },
    scripts: [],
    managedScript: null,
    editableScript: null,
    source: '',
    document: { version: 2, rules: [] },
    visualizationError: null,
    parseError: null,
    ...overrides,
  };
}

function folder(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    account_id: 1,
    remote_id: `mailbox-${id}`,
    parent_id: null,
    name: `Folder ${id}`,
    role: null,
    sort_order: 0,
    is_deleted: 0,
    is_subscribed: 1,
    total_emails: 0,
    unread_emails: 0,
    rights_json: null,
    may_add_items: 1,
    ...overrides,
  } as any;
}

function mountDialog() {
  return mount(MailRulesDialog, {
    global: { stubs: { teleport: true } },
  });
}

function installRepo({
  incompatible = false,
  saveGate = null,
}: { incompatible?: boolean; saveGate?: Promise<void> | null } = {}) {
  let serverSnapshot = snapshot(incompatible ? {
    scripts: [{ id: 'foreign', name: 'Handwritten filters', isActive: true }],
    editableScript: { id: 'foreign', name: 'Handwritten filters', isActive: true },
    source: 'vacation "Away";\r\n',
    visualizationError: 'Top-level “vacation” is not represented by the visual editor at line 1.',
  } : {});
  let pendingRequest: any = null;
  const repo = {
    getMailRules: vi.fn(async () => structuredClone(serverSnapshot)),
    insertPendingMutation: vi.fn(async (input) => {
      pendingRequest = JSON.parse(input.requestJson);
      return { id: 72 };
    }),
    runMutation: vi.fn(async () => {
      if (saveGate) await saveGate;
      serverSnapshot = pendingRequest.mode === 'source'
        ? snapshot({
          state: 'sieve-state-2',
          scripts: [{ id: 'foreign', name: 'Handwritten filters', isActive: true }],
          editableScript: { id: 'foreign', name: 'Handwritten filters', isActive: true },
          source: pendingRequest.source,
          visualizationError: 'Top-level “vacation” is not represented by the visual editor at line 1.',
        })
        : snapshot({
          state: 'sieve-state-2',
          document: pendingRequest.document,
          scripts: [{ id: 'managed', name: 'Stormbox Mail Rules', isActive: true }],
          managedScript: { id: 'managed', name: 'Stormbox Mail Rules', isActive: true },
          editableScript: { id: 'managed', name: 'Stormbox Mail Rules', isActive: true },
        });
      return { attempted: 1, succeeded: 1, failed: 0 };
    }),
    getPendingMutationError: vi.fn(),
  };
  __setRepositoryForTests(repo);
  return repo;
}

beforeEach(() => {
  setActivePinia(createPinia());
  __resetRepositoryForTests();
  useAuthStore().accountId = 1;
  useMailStore().folders = [
    folder(1, { name: 'Projects' }),
    folder(2, { name: 'Receipts', parent_id: 1 }),
  ];
});

describe('MailRulesDialog', () => {
  it('creates and saves a visual rule through the durable mutation path', async () => {
    const repo = installRepo();
    const wrapper = mountDialog();
    await flushPromises();

    expect(wrapper.text()).toContain('No rules yet');
    await wrapper.get('[data-mail-rules-add]').trigger('click');
    expect(wrapper.find('select').exists()).toBe(false);
    await wrapper.get('input[aria-label="Condition value"]').setValue('newsletter');
    await wrapper.get('[data-mail-rules-save]').trigger('click');
    await flushPromises();

    expect(repo.insertPendingMutation).toHaveBeenCalledTimes(1);
    const queued = JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson);
    expect(queued.mode).toBe('visual');
    expect(queued.document.rules).toHaveLength(1);
    expect(queued.document.rules[0]).toMatchObject({
      name: 'New rule',
      conditions: [{ field: 'from', operator: 'contains', value: 'newsletter' }],
      actions: [{ type: 'markRead' }],
    });
    expect(wrapper.text()).toContain('Rules saved, validated, and activated.');
  });

  it('builds nested any/all condition groups', async () => {
    const repo = installRepo();
    const wrapper = mountDialog();
    await flushPromises();

    await wrapper.get('[data-mail-rules-add]').trigger('click');
    await wrapper.get('input[aria-label="Condition value"]').setValue('project');
    const addGroup = wrapper.findAll('button').find((button) => button.text().trim() === 'Group');
    expect(addGroup).toBeTruthy();
    await addGroup!.trigger('click');

    await wrapper.get('.condition-group--nested summary[aria-label="Nested condition match mode"]')
      .trigger('click');
    await wrapper.get('.condition-group--nested [data-rule-option="any"]').trigger('click');
    await wrapper.get('.condition-group--nested .condition-group__header input[type="checkbox"]')
      .setValue(true);
    await wrapper.get('.condition-group--nested input[aria-label="Condition value"]')
      .setValue('lead@example.com');
    const addNestedCondition = wrapper.get('.condition-group--nested').findAll('button')
      .find((button) => button.text().trim() === 'Condition');
    await addNestedCondition!.trigger('click');
    const nestedValues = wrapper.get('.condition-group--nested')
      .findAll('input[aria-label="Condition value"]');
    expect(nestedValues).toHaveLength(2);
    await nestedValues[1].setValue('manager@example.com');

    await wrapper.get('[data-mail-rules-save]').trigger('click');
    await flushPromises();

    const queued = JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson);
    expect(queued.document.rules[0]).toMatchObject({
      match: 'all',
      conditions: [
        { type: 'condition', value: 'project' },
        {
          type: 'group',
          match: 'any',
          negated: true,
          conditions: [
            { type: 'condition', value: 'lead@example.com' },
            { type: 'condition', value: 'manager@example.com' },
          ],
        },
      ],
    });
  });

  it('switches between visual rules and their generated source', async () => {
    installRepo();
    const wrapper = mountDialog();
    await flushPromises();

    await wrapper.get('[data-mail-rules-add]').trigger('click');
    await wrapper.get('input[aria-label="Condition value"]').setValue('newsletter');
    const sourceTab = wrapper.findAll('.mail-rules__mode-switch button')
      .find((tab) => tab.text().trim() === 'Source');
    await sourceTab!.trigger('click');

    expect(wrapper.get('textarea[aria-label="Sieve source"]').element)
      .toHaveProperty('value', expect.stringContaining('address :contains "From" "newsletter"'));

    const visualTab = wrapper.findAll('.mail-rules__mode-switch button')
      .find((tab) => tab.text().trim() === 'Visual');
    await visualTab!.trigger('click');
    expect(wrapper.get('input[aria-label="Condition value"]').element)
      .toHaveProperty('value', 'newsletter');
  });

  it('locks the draft while a server save is in flight', async () => {
    let releaseSave = () => {};
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    installRepo({ saveGate });
    const wrapper = mountDialog();
    await flushPromises();

    await wrapper.get('[data-mail-rules-add]').trigger('click');
    const condition = wrapper.get('input[aria-label="Condition value"]');
    await condition.setValue('locked');
    await wrapper.get('[data-mail-rules-save]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-mail-rules-save]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('input[aria-label="Condition value"]').attributes('disabled')).toBeDefined();

    releaseSave();
    await flushPromises();
    expect(wrapper.text()).toContain('Rules saved, validated, and activated.');
  });

  it('falls back to source and saves an incompatible active script in place', async () => {
    const repo = installRepo({ incompatible: true });
    const wrapper = mountDialog();
    await flushPromises();

    expect(wrapper.text()).toContain('Handwritten filters');
    expect(wrapper.text()).toContain('Top-level “vacation” is not represented by the visual editor at line 1.');
    const source = wrapper.get('textarea[aria-label="Sieve source"]');
    expect(source.element).toHaveProperty('value', 'vacation "Away";\r\n');

    const visualTab = wrapper.findAll('.mail-rules__mode-switch button')
      .find((tab) => tab.text().trim() === 'Visual');
    await visualTab!.trigger('click');
    expect(wrapper.get('[role="alert"]').text()).toContain(
      'Top-level “vacation” is not represented by the visual editor at line 1.',
    );

    await source.setValue('vacation "Back Monday";\r\n');
    await wrapper.get('[data-mail-rules-save]').trigger('click');
    await flushPromises();
    const queued = JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson);
    expect(queued).toEqual({
      mode: 'source',
      source: 'vacation "Back Monday";\r\n',
      expectedState: 'sieve-state-1',
    });
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Sieve source saved, validated, and activated.');
  });

  it('confirms before discarding an edited draft', async () => {
    installRepo();
    const wrapper = mountDialog();
    await flushPromises();

    await wrapper.get('[data-mail-rules-add]').trigger('click');
    await wrapper.get('button[aria-label="Close mail rules"]').trigger('click');
    expect(wrapper.get('[role="alertdialog"]').text()).toContain('Discard unsaved changes?');

    await wrapper.get('[data-mail-rules-confirm]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
