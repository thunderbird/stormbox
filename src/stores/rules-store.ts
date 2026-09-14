import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { getRepositoryAsync } from '../composables/useRepository';
import { MUTATION_TYPE } from '../constants/states';
import {
  cloneRuleDocument,
  compileRules,
  emptyRuleDocument,
  normalizeRuleDocument,
} from '../sieve/rules';
import type { MailRuleDocument, SieveRuleCapabilities } from '../sieve/rules';
import { useAuthStore } from './auth-store';

interface RuleScriptSummary {
  id: string;
  name: string | null;
  isActive?: boolean;
}

export interface MailRulesSnapshot {
  supported: boolean;
  accountId: string | null;
  state: string | null;
  capabilities: SieveRuleCapabilities;
  scripts: RuleScriptSummary[];
  managedScript: RuleScriptSummary | null;
  editableScript: RuleScriptSummary | null;
  source: string;
  document: MailRuleDocument;
  visualizationError: string | null;
  parseError: string | null;
}

export class MailRulesSaveError extends Error {
  code: string;
  detail: any;

  constructor(code: string, message: string, detail: any = null) {
    super(message);
    this.name = 'MailRulesSaveError';
    this.code = code;
    this.detail = detail;
  }
}

export const useRulesStore = defineStore('rules', () => {
  const authStore = useAuthStore();
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);
  const snapshot = ref<MailRulesSnapshot | null>(null);

  const supported = computed(() => snapshot.value?.supported === true);
  const capabilities = computed<SieveRuleCapabilities>(() =>
    snapshot.value?.capabilities ?? { sieveExtensions: [] });

  async function load(): Promise<MailRulesSnapshot> {
    if (authStore.accountId == null) {
      throw new MailRulesSaveError('notConnected', 'Sign in before managing mail rules.');
    }
    loading.value = true;
    error.value = null;
    try {
      const repo = await getRepositoryAsync();
      const result = await repo.getMailRules(authStore.accountId) as MailRulesSnapshot;
      snapshot.value = {
        ...result,
        document: normalizeRuleDocument(result?.document ?? emptyRuleDocument()),
      };
      return snapshot.value;
    } catch (cause) {
      error.value = errorMessage(cause);
      throw cause;
    } finally {
      loading.value = false;
    }
  }

  async function save(input: MailRuleDocument): Promise<MailRulesSnapshot> {
    const current = await requireWritableSnapshot();
    const document = normalizeRuleDocument(input);
    // Give immediate editor feedback; the SharedWorker compiles again
    // against a freshly fetched capability snapshot before uploading.
    compileRules(document, current.capabilities, {
      managed: current.managedScript !== null || current.editableScript === null,
    });
    return persist({ mode: 'visual', document }, current);
  }

  async function saveSource(source: string): Promise<MailRulesSnapshot> {
    const current = await requireWritableSnapshot();
    const size = new TextEncoder().encode(source).byteLength;
    if (
      typeof current.capabilities.maxSizeScript === 'number'
      && size > current.capabilities.maxSizeScript
    ) {
      throw new MailRulesSaveError(
        'invalidSieve',
        `The script is ${size} bytes; the server limit is ${current.capabilities.maxSizeScript}.`,
      );
    }
    return persist({ mode: 'source', source }, current);
  }

  async function requireWritableSnapshot(): Promise<MailRulesSnapshot> {
    if (authStore.accountId == null) {
      throw new MailRulesSaveError('notConnected', 'Sign in before saving mail rules.');
    }
    if (!snapshot.value) await load();
    if (!snapshot.value?.supported) {
      throw new MailRulesSaveError('sieveUnsupported', 'This account does not support JMAP for Sieve.');
    }
    if (snapshot.value.parseError) {
      throw new MailRulesSaveError('managedScriptUnreadable', snapshot.value.parseError);
    }
    return snapshot.value;
  }

  async function persist(
    request: Record<string, unknown>,
    current: MailRulesSnapshot,
  ): Promise<MailRulesSnapshot> {
    const accountId = authStore.accountId;
    if (accountId == null) {
      throw new MailRulesSaveError('notConnected', 'Sign in before saving mail rules.');
    }
    saving.value = true;
    error.value = null;
    try {
      const repo = await getRepositoryAsync();
      const inserted = await repo.insertPendingMutation({
        accountId,
        mutationType: MUTATION_TYPE.SET_SIEVE_RULES,
        targetMessageId: null,
        requestJson: JSON.stringify({
          ...request,
          expectedState: current.state,
        }),
        optimisticPatchJson: null,
      });
      const outcome = await repo.runMutation(accountId, inserted.id);
      if ((outcome?.failed ?? 0) > 0) {
        const row = await repo.getPendingMutationError(inserted.id);
        const detail = parseErrorJson(row?.error_json);
        const code = detail?.type ?? 'saveFailed';
        throw new MailRulesSaveError(
          code,
          detail?.message ?? 'The server did not save the mail rules.',
          detail?.result ?? detail,
        );
      }
      return await load();
    } catch (cause) {
      error.value = errorMessage(cause);
      throw cause;
    } finally {
      saving.value = false;
    }
  }

  function freshDocument(): MailRuleDocument {
    return cloneRuleDocument(snapshot.value?.document ?? emptyRuleDocument());
  }

  function freshSource(): string {
    return snapshot.value?.source ?? '';
  }

  function $reset() {
    loading.value = false;
    saving.value = false;
    error.value = null;
    snapshot.value = null;
  }

  return {
    loading,
    saving,
    error,
    snapshot,
    supported,
    capabilities,
    load,
    save,
    saveSource,
    freshDocument,
    freshSource,
    $reset,
  };
});

function parseErrorJson(value: unknown): any {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
