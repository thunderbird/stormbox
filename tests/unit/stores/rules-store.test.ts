// @vitest-environment happy-dom

import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import {
  __resetRepositoryForTests,
  __setRepositoryForTests,
} from '../../../src/composables/useRepository';
import { MUTATION_TYPE } from '../../../src/constants/states';
import { compileRules } from '../../../src/sieve/rules';
import type { MailRuleDocument } from '../../../src/sieve/rules';
import { useAuthStore } from '../../../src/stores/auth-store';
import {
  MailRulesSaveError,
  useRulesStore,
} from '../../../src/stores/rules-store';

function document(): MailRuleDocument {
  return {
    version: 2,
    rules: [{
      id: 'rule-1',
      name: 'Receipts',
      enabled: true,
      match: 'all',
      conditions: [{
        id: 'condition-1', type: 'condition', negated: false,
        field: 'subject', operator: 'contains', value: 'Receipt',
      }],
      actions: [{ id: 'action-1', type: 'markRead' }],
      stopProcessing: true,
    }],
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    supported: true,
    accountId: 'remote-1',
    state: 'sieve-state-1',
    capabilities: {
      sieveExtensions: ['imap4flags'],
      maxSizeScript: 64_000,
      maxNumberRedirects: 4,
    },
    scripts: [],
    managedScript: null,
    editableScript: null,
    source: '',
    document: document(),
    visualizationError: null,
    parseError: null,
    ...overrides,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  __resetRepositoryForTests();
});

describe('rules store', () => {
  it('loads a normalized snapshot and returns isolated drafts', async () => {
    const repo = { getMailRules: vi.fn(async () => snapshot()) };
    __setRepositoryForTests(repo);
    useAuthStore().accountId = 7;
    const store = useRulesStore();

    const loaded = await store.load();
    const draft = store.freshDocument();
    draft.rules[0].name = 'Edited locally';

    expect(repo.getMailRules).toHaveBeenCalledWith(7);
    expect(loaded.state).toBe('sieve-state-1');
    expect(store.snapshot?.document.rules[0].name).toBe('Receipts');
    expect(store.loading).toBe(false);
  });

  it('queues and runs a state-checked durable mutation before reloading', async () => {
    const repo = {
      getMailRules: vi.fn(async () => snapshot()),
      insertPendingMutation: vi.fn(async (_input: any) => ({ id: 93 })),
      runMutation: vi.fn(async () => ({ attempted: 1, succeeded: 1, failed: 0 })),
      getPendingMutationError: vi.fn(),
    };
    __setRepositoryForTests(repo);
    useAuthStore().accountId = 7;
    const store = useRulesStore();
    await store.load();

    await store.save(document());

    expect(repo.insertPendingMutation).toHaveBeenCalledTimes(1);
    const pending = repo.insertPendingMutation.mock.calls[0][0];
    expect(pending).toMatchObject({
      accountId: 7,
      mutationType: MUTATION_TYPE.SET_SIEVE_RULES,
      targetMessageId: null,
      optimisticPatchJson: null,
    });
    expect(JSON.parse(pending.requestJson)).toEqual({
      mode: 'visual',
      document: document(),
      expectedState: 'sieve-state-1',
    });
    expect(repo.runMutation).toHaveBeenCalledWith(7, 93);
    expect(repo.getMailRules).toHaveBeenCalledTimes(2);
    expect(store.saving).toBe(false);
  });

  it('sizes an editable external script without adding a managed marker', async () => {
    const input = document();
    const capabilities = {
      sieveExtensions: ['imap4flags'],
      maxSizeScript: null,
      maxNumberRedirects: 4,
    };
    const externalSource = compileRules(input, capabilities, { managed: false });
    const externalSnapshot = snapshot({
      capabilities: {
        ...capabilities,
        maxSizeScript: new TextEncoder().encode(externalSource).length,
      },
      editableScript: { id: 'personal', name: 'Personal filters', isActive: true },
      source: externalSource,
    });
    const repo = {
      getMailRules: vi.fn(async () => externalSnapshot),
      insertPendingMutation: vi.fn(async () => ({ id: 95 })),
      runMutation: vi.fn(async () => ({ attempted: 1, succeeded: 1, failed: 0 })),
      getPendingMutationError: vi.fn(),
    };
    __setRepositoryForTests(repo);
    useAuthStore().accountId = 7;
    const store = useRulesStore();
    await store.load();

    await expect(store.save(input)).resolves.toMatchObject({
      editableScript: { id: 'personal' },
    });
    expect(repo.insertPendingMutation).toHaveBeenCalledOnce();
  });

  it('queues raw source without requiring visual projection', async () => {
    const rawSource = 'vacation "Away";\r\n';
    const repo = {
      getMailRules: vi.fn(async () => snapshot({
        editableScript: { id: 'personal', name: 'Personal filters', isActive: true },
        source: rawSource,
        visualizationError: 'Top-level “vacation” is not represented by the visual editor at line 1.',
      })),
      insertPendingMutation: vi.fn(async (_input: any) => ({ id: 96 })),
      runMutation: vi.fn(async () => ({ attempted: 1, succeeded: 1, failed: 0 })),
      getPendingMutationError: vi.fn(),
    };
    __setRepositoryForTests(repo);
    useAuthStore().accountId = 7;
    const store = useRulesStore();
    await store.load();

    await store.saveSource('vacation "Back Monday";\r\n');

    const pending = repo.insertPendingMutation.mock.calls[0][0];
    expect(JSON.parse(pending.requestJson)).toEqual({
      mode: 'source',
      source: 'vacation "Back Monday";\r\n',
      expectedState: 'sieve-state-1',
    });
  });

  it('surfaces the typed terminal error left by the outbox', async () => {
    const repo = {
      getMailRules: vi.fn(async () => snapshot()),
      insertPendingMutation: vi.fn(async () => ({ id: 94 })),
      runMutation: vi.fn(async () => ({ attempted: 1, succeeded: 0, failed: 1 })),
      getPendingMutationError: vi.fn(async () => ({
        error_json: JSON.stringify({
          type: 'invalidSieve',
          message: 'The server rejected the script.',
          result: { validationError: { type: 'invalidSieve' } },
        }),
      })),
    };
    __setRepositoryForTests(repo);
    useAuthStore().accountId = 7;
    const store = useRulesStore();
    await store.load();

    await expect(store.save(document())).rejects.toMatchObject({
      name: 'MailRulesSaveError',
      code: 'invalidSieve',
      message: 'The server rejected the script.',
      detail: { validationError: { type: 'invalidSieve' } },
    } satisfies Partial<MailRulesSaveError>);
    expect(store.error).toBe('The server rejected the script.');
    expect(store.saving).toBe(false);
  });

  it('requires an authenticated local account', async () => {
    __setRepositoryForTests({});
    const store = useRulesStore();
    await expect(store.load()).rejects.toMatchObject({ code: 'notConnected' });
  });
});
