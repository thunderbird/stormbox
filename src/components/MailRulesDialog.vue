<script setup lang="ts">
import {
  computed, nextTick, onBeforeUnmount, onMounted, ref,
} from 'vue';
import {
  ArrowDown, ArrowUp, CircleAlert, Filter, Plus, Trash2, X,
} from '@lucide/vue';

import AppButton from './AppButton.vue';
import MailRuleSelect from './MailRuleSelect.vue';
import MailRuleTestEditor from './MailRuleTestEditor.vue';
import { useAuthStore } from '../stores/auth-store';
import { useMailStore } from '../stores/mail-store';
import { useRulesStore } from '../stores/rules-store';
import {
  cloneRuleDocument,
  compileRules,
  createEmptyRule,
  newRuleId,
  normalizeRuleDocument,
  parseRulesSource,
  RuleValidationError,
} from '../sieve/rules';
import type {
  MailRule, MailRuleAction, MailRuleDocument,
} from '../sieve/rules';

const emit = defineEmits<{ (event: 'close'): void }>();

const authStore = useAuthStore();
const mailStore = useMailStore();
const rulesStore = useRulesStore();
const panelEl = ref<HTMLElement | null>(null);
const closeButtonEl = ref<HTMLButtonElement | null>(null);
const mode = ref<'visual' | 'source'>('visual');
const draft = ref<MailRuleDocument>({ version: 2, rules: [] });
const baseline = ref('');
const sourceDraft = ref('');
const sourceBaseline = ref('');
const visualSourceCheckpoint = ref('');
const localError = ref<string | null>(null);
const modeError = ref<string | null>(null);
const notice = ref<string | null>(null);
const confirmation = ref<'discard' | null>(null);

const busy = computed(() => rulesStore.loading || rulesStore.saving);
const dirty = computed(() =>
  JSON.stringify(draft.value) !== baseline.value
  || sourceDraft.value !== sourceBaseline.value);
const extensions = computed(() => new Set(rulesStore.capabilities.sieveExtensions));
const canMove = computed(() => extensions.value.has('fileinto'));
const canFlags = computed(() => extensions.value.has('imap4flags'));
const canRedirectCopy = computed(() => extensions.value.has('copy'));

const folderOptions = computed(() => {
  const ownFolders = mailStore.folders.filter((folder) =>
    folder.account_id === authStore.accountId
    && folder.is_deleted !== 1
    && folder.may_add_items !== 0);
  const byId = new Map(ownFolders.map((folder) => [folder.id, folder]));
  return ownFolders
    .map((folder) => {
      const names: string[] = [];
      const visited = new Set<number>();
      let current: typeof folder | undefined = folder;
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        names.unshift(current.name);
        current = current.parent_id == null ? undefined : byId.get(current.parent_id);
      }
      return { remoteId: folder.remote_id, label: names.join('/') };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
});

const actionOptions = [
  { value: 'move', label: 'Move to folder' },
  { value: 'markRead', label: 'Mark as read' },
  { value: 'star', label: 'Star' },
  { value: 'redirect', label: 'Forward a copy' },
  { value: 'discard', label: 'Discard' },
] as const;

const availableActionOptions = computed(() => actionOptions.map((option) => ({
  ...option,
  disabled: !actionSupported(option.value),
})));

const folderSelectOptions = computed(() => folderOptions.value.map((folder) => ({
  value: folder.remoteId,
  label: folder.label,
})));

function actionSupported(type: MailRuleAction['type']): boolean {
  if (type === 'move') return canMove.value;
  if (type === 'markRead' || type === 'star') return canFlags.value;
  if (type === 'redirect') return canRedirectCopy.value;
  return true;
}

function addRule() {
  const rule = createEmptyRule();
  if (!canFlags.value) rule.actions = [createDefaultAction()];
  draft.value.rules.push(rule);
  localError.value = null;
}

function removeRule(index: number) {
  draft.value.rules.splice(index, 1);
}

function moveRule(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= draft.value.rules.length) return;
  const [rule] = draft.value.rules.splice(index, 1);
  draft.value.rules.splice(target, 0, rule);
}

function addAction(rule: MailRule) {
  rule.actions.push(createDefaultAction());
}

function removeAction(rule: MailRule, index: number) {
  if (rule.actions.length <= 1) return;
  rule.actions.splice(index, 1);
}

function onActionTypeChange(rule: MailRule, index: number, value: string) {
  const type = value as MailRuleAction['type'];
  rule.actions.splice(index, 1, createAction(type));
}

function onMoveTargetChange(action: Extract<MailRuleAction, { type: 'move' }>, mailboxId: string) {
  const target = folderOptions.value.find((folder) => folder.remoteId === mailboxId);
  action.mailboxId = mailboxId;
  action.mailboxName = target?.label ?? action.mailboxName;
}

function createDefaultAction(): MailRuleAction {
  const order: MailRuleAction['type'][] = ['move', 'markRead', 'discard'];
  return createAction(order.find(actionSupported) ?? 'discard');
}

function createAction(type: MailRuleAction['type']): MailRuleAction {
  const id = newRuleId('action');
  if (type === 'move') {
    const folder = folderOptions.value[0];
    return {
      id,
      type,
      mailboxId: folder?.remoteId ?? '',
      mailboxName: folder?.label ?? '',
    };
  }
  if (type === 'redirect') return { id, type, address: '' };
  return { id, type };
}

async function load() {
  localError.value = null;
  modeError.value = null;
  notice.value = null;
  try {
    await rulesStore.load();
    syncDrafts();
  } catch (error) {
    localError.value = errorMessage(error);
  }
}

function syncDrafts(preferredMode?: 'visual' | 'source') {
  draft.value = resolveFolderTargets(rulesStore.freshDocument());
  baseline.value = JSON.stringify(draft.value);
  visualSourceCheckpoint.value = baseline.value;
  sourceDraft.value = rulesStore.freshSource();
  sourceBaseline.value = sourceDraft.value;
  mode.value = rulesStore.snapshot?.visualizationError
    ? 'source'
    : (preferredMode ?? 'visual');
}

function switchToSource() {
  if (mode.value === 'source') return;
  localError.value = null;
  modeError.value = null;
  const currentDocument = JSON.stringify(draft.value);
  if (currentDocument !== visualSourceCheckpoint.value) {
    try {
      draft.value = refreshFolderFallbacks(draft.value);
      sourceDraft.value = compileRules(draft.value, rulesStore.capabilities, {
        managed: rulesStore.snapshot?.managedScript != null
          || rulesStore.snapshot?.editableScript == null,
      });
      visualSourceCheckpoint.value = JSON.stringify(draft.value);
    } catch (error) {
      modeError.value = errorMessage(error);
      return;
    }
  }
  mode.value = 'source';
}

function switchToVisual() {
  if (mode.value === 'visual') return;
  localError.value = null;
  modeError.value = null;
  try {
    draft.value = resolveFolderTargets(parseRulesSource(sourceDraft.value));
    visualSourceCheckpoint.value = JSON.stringify(draft.value);
    mode.value = 'visual';
  } catch (error) {
    modeError.value = errorMessage(error);
  }
}

function requestSave() {
  localError.value = null;
  modeError.value = null;
  notice.value = null;
  if (mode.value === 'source') {
    void persist();
    return;
  }
  try {
    draft.value = refreshFolderFallbacks(draft.value);
    normalizeRuleDocument(draft.value);
  } catch (error) {
    localError.value = errorMessage(error);
    return;
  }
  void persist();
}

async function persist() {
  localError.value = null;
  notice.value = null;
  try {
    const savedMode = mode.value;
    if (savedMode === 'source') await rulesStore.saveSource(sourceDraft.value);
    else await rulesStore.save(draft.value);
    syncDrafts(savedMode);
    notice.value = savedMode === 'source'
      ? 'Sieve source saved, validated, and activated.'
      : 'Rules saved, validated, and activated.';
  } catch (error) {
    localError.value = errorMessage(error);
  }
}

function refreshFolderFallbacks(input: MailRuleDocument): MailRuleDocument {
  const document = cloneRuleDocument(input);
  const folders = new Map(folderOptions.value.map((folder) => [folder.remoteId, folder.label]));
  for (const rule of document.rules) {
    for (const action of rule.actions) {
      if (action.type !== 'move') continue;
      const label = folders.get(action.mailboxId);
      if (!label) {
        throw new RuleValidationError(
          `The destination folder in “${rule.name || 'Unnamed rule'}” is no longer available.`,
        );
      }
      action.mailboxName = label;
    }
  }
  return document;
}

function resolveFolderTargets(input: MailRuleDocument): MailRuleDocument {
  const document = cloneRuleDocument(input);
  const foldersByLabel = new Map(folderOptions.value.map((folder) => [folder.label, folder.remoteId]));
  for (const rule of document.rules) {
    for (const action of rule.actions) {
      if (action.type === 'move' && !action.mailboxId) {
        action.mailboxId = foldersByLabel.get(action.mailboxName) ?? '';
      }
    }
  }
  return document;
}

function requestClose() {
  if (busy.value) return;
  if (dirty.value) {
    confirmation.value = 'discard';
    focusConfirmation();
    return;
  }
  emit('close');
}

function cancelConfirmation() {
  confirmation.value = null;
  nextTick(() => closeButtonEl.value?.focus());
}

function confirmDiscard() {
  confirmation.value = null;
  emit('close');
}

function focusConfirmation() {
  nextTick(() => {
    panelEl.value?.querySelector<HTMLElement>('[data-mail-rules-confirm]')?.focus();
  });
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (confirmation.value) {
      cancelConfirmation();
      return;
    }
    requestClose();
    return;
  }
  if (event.key !== 'Tab' || !panelEl.value) return;
  const focusRoot = confirmation.value
    ? panelEl.value.querySelector<HTMLElement>('.mail-rules__confirm')
    : panelEl.value;
  if (!focusRoot) return;
  const focusable = [...focusRoot.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), summary:not([aria-disabled="true"]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.offsetParent !== null);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function scriptLabel(script: { name?: string | null } | null): string {
  return script?.name?.trim() || 'Unnamed script';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

onMounted(async () => {
  window.addEventListener('keydown', onWindowKeydown);
  closeButtonEl.value?.focus();
  await load();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div class="mail-rules" role="presentation" @click.self="requestClose">
      <section
        ref="panelEl"
        class="mail-rules__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mail-rules-title"
      >
        <header class="mail-rules__header">
          <div>
            <h2 id="mail-rules-title">Mail Rules</h2>
            <p>Filter new mail on the server, even while Stormbox is closed.</p>
          </div>
          <button
            ref="closeButtonEl"
            class="mail-rules__icon-button"
            type="button"
            aria-label="Close mail rules"
            :disabled="busy"
            @click="requestClose"
          >
            <X :size="19" :stroke-width="2" aria-hidden="true" />
          </button>
        </header>

        <main class="mail-rules__body">
          <p v-if="rulesStore.loading" class="mail-rules__empty" role="status">
            Loading server rules…
          </p>

          <div v-if="localError || rulesStore.error" class="mail-rules__alert mail-rules__alert--error" role="alert">
            <CircleAlert :size="18" aria-hidden="true" />
            <div>
              <strong>Mail rules could not be loaded or saved.</strong>
              <p>{{ localError || rulesStore.error }}</p>
              <button v-if="!rulesStore.saving" type="button" class="mail-rules__text-button" @click="load">
                Reload from server
              </button>
            </div>
          </div>

          <div v-if="notice" class="mail-rules__alert mail-rules__alert--success" role="status">
            {{ notice }}
          </div>

          <template v-if="!rulesStore.loading && rulesStore.snapshot">
            <div v-if="!rulesStore.supported" class="mail-rules__alert" role="status">
              This account does not advertise JMAP for Sieve, so server-side rules are unavailable.
            </div>

            <div v-else-if="rulesStore.snapshot.parseError" class="mail-rules__alert mail-rules__alert--error" role="alert">
              <CircleAlert :size="18" aria-hidden="true" />
              <div>
                <strong>Stormbox cannot choose a script to edit.</strong>
                <p>{{ rulesStore.snapshot.parseError }}</p>
              </div>
            </div>

            <template v-else-if="rulesStore.supported">
              <div class="mail-rules__mode-switch" role="group" aria-label="Mail rules editor mode">
                <button
                  type="button"
                  :aria-pressed="mode === 'visual'"
                  :disabled="busy"
                  @click="switchToVisual"
                >Visual</button>
                <button
                  type="button"
                  :aria-pressed="mode === 'source'"
                  :disabled="busy"
                  @click="switchToSource"
                >Source</button>
              </div>

              <div v-if="modeError" class="mail-rules__alert mail-rules__alert--warning" role="alert">
                <CircleAlert :size="18" aria-hidden="true" />
                <div>
                  <strong>Cannot switch to the visual editor.</strong>
                  <p>{{ modeError }}</p>
                </div>
              </div>

              <div
                v-if="mode === 'source' && rulesStore.snapshot.visualizationError && !modeError"
                class="mail-rules__alert mail-rules__alert--warning"
                role="status"
              >
                <CircleAlert :size="18" aria-hidden="true" />
                <div>
                  <strong>This script cannot be represented visually.</strong>
                  <p>{{ rulesStore.snapshot.visualizationError }}</p>
                  <p>Edit its complete source below. The server will validate it before saving.</p>
                </div>
              </div>

              <div
                v-else-if="mode === 'visual' && rulesStore.snapshot.editableScript"
                class="mail-rules__alert"
                role="status"
              >
                <div>
                  <strong>This script is visually compatible.</strong>
                  <p>Visual saves preserve its behavior, but normalize source formatting and comments.</p>
                </div>
              </div>

              <div v-if="mode === 'visual'" aria-label="Visual rule editor">
                <div class="mail-rules__toolbar">
                  <div class="mail-rules__summary">
                    <Filter :size="17" aria-hidden="true" />
                    <span>{{ draft.rules.length }} {{ draft.rules.length === 1 ? 'rule' : 'rules' }}</span>
                  </div>
                  <AppButton data-mail-rules-add :disabled="busy" @click="addRule">
                    <template #iconLeft><Plus :size="16" aria-hidden="true" /></template>
                    Add rule
                  </AppButton>
                </div>

                <p v-if="draft.rules.length === 0" class="mail-rules__empty">
                  No rules yet. Add one, or save an empty ruleset to keep all incoming mail unchanged.
                </p>

                <fieldset class="mail-rules__fieldset" :disabled="busy">
                  <article
                    v-for="(rule, ruleIndex) in draft.rules"
                    :key="rule.id"
                    class="mail-rule"
                  >
                  <header class="mail-rule__header">
                    <label class="mail-rule__enabled">
                      <input v-model="rule.enabled" type="checkbox" />
                      <span class="sr-only">Enable rule</span>
                    </label>
                    <input
                      v-model="rule.name"
                      class="mail-rule__name"
                      type="text"
                      aria-label="Rule name"
                      placeholder="Rule name"
                    />
                    <button
                      class="mail-rules__icon-button"
                      type="button"
                      :disabled="ruleIndex === 0"
                      aria-label="Move rule up"
                      @click="moveRule(ruleIndex, -1)"
                    ><ArrowUp :size="16" aria-hidden="true" /></button>
                    <button
                      class="mail-rules__icon-button"
                      type="button"
                      :disabled="ruleIndex === draft.rules.length - 1"
                      aria-label="Move rule down"
                      @click="moveRule(ruleIndex, 1)"
                    ><ArrowDown :size="16" aria-hidden="true" /></button>
                    <button
                      class="mail-rules__icon-button mail-rules__icon-button--danger"
                      type="button"
                      aria-label="Delete rule"
                      @click="removeRule(ruleIndex)"
                    ><Trash2 :size="16" aria-hidden="true" /></button>
                  </header>

                  <div class="mail-rule__section">
                    <MailRuleTestEditor
                      root
                      :match="rule.match"
                      :conditions="rule.conditions"
                      :disabled="busy"
                      @update:match="rule.match = $event"
                      @update:conditions="rule.conditions = $event"
                    />
                  </div>

                  <div class="mail-rule__section">
                    <div class="mail-rule__section-title"><span>Then</span></div>
                    <div
                      v-for="(action, actionIndex) in rule.actions"
                      :key="action.id"
                      class="mail-rule__row mail-rule__action"
                    >
                      <MailRuleSelect
                        :model-value="action.type"
                        :options="availableActionOptions"
                        control-label="Rule action"
                        :disabled="busy"
                        @update:model-value="onActionTypeChange(rule, actionIndex, $event)"
                      />
                      <MailRuleSelect
                        v-if="action.type === 'move'"
                        :model-value="action.mailboxId"
                        :options="folderSelectOptions"
                        control-label="Destination folder"
                        placeholder="Select folder"
                        :disabled="busy"
                        @update:model-value="onMoveTargetChange(action, $event)"
                      />
                      <input
                        v-else-if="action.type === 'redirect'"
                        v-model="action.address"
                        type="email"
                        aria-label="Forwarding address"
                        placeholder="person@example.com"
                      />
                      <span v-else class="mail-rule__action-description">
                        {{ actionOptions.find((option) => option.value === action.type)?.label }}
                      </span>
                      <button
                        class="mail-rules__icon-button"
                        type="button"
                        :disabled="rule.actions.length === 1"
                        aria-label="Remove action"
                        @click="removeAction(rule, actionIndex)"
                      ><X :size="15" aria-hidden="true" /></button>
                    </div>
                    <button class="mail-rules__text-button" type="button" @click="addAction(rule)">
                      + Add action
                    </button>
                    <label class="mail-rule__stop">
                      <input v-model="rule.stopProcessing" type="checkbox" />
                      Stop processing later rules when this rule matches
                    </label>
                  </div>
                  </article>
                </fieldset>
              </div>

              <div v-else class="mail-rules__source" aria-label="Sieve source editor">
                <div class="mail-rules__source-heading">
                  <strong>Sieve source</strong>
                  <span>
                    {{ rulesStore.snapshot.editableScript
                      ? scriptLabel(rulesStore.snapshot.editableScript)
                      : 'New script' }}
                  </span>
                </div>
                <textarea
                  v-model="sourceDraft"
                  aria-label="Sieve source"
                  :disabled="busy"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                />
              </div>
            </template>
          </template>
        </main>

        <footer class="mail-rules__footer">
          <span class="mail-rules__footer-status">
            <template v-if="rulesStore.saving">Uploading and validating…</template>
            <template v-else-if="dirty">Unsaved changes</template>
          </span>
          <AppButton variant="outline" :disabled="busy" @click="requestClose">Close</AppButton>
          <AppButton
            data-mail-rules-save
            :disabled="busy || !rulesStore.supported || Boolean(rulesStore.snapshot?.parseError)"
            @click="requestSave"
          >Save and activate</AppButton>
        </footer>

        <div v-if="confirmation" class="mail-rules__confirm-backdrop" role="presentation">
          <section
            class="mail-rules__confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="discard-title"
          >
            <h3 id="discard-title">Discard unsaved changes?</h3>
            <p>Your server-side rules will stay as they were when this editor opened.</p>
            <div class="mail-rules__confirm-actions">
              <AppButton variant="outline" @click="cancelConfirmation">Keep editing</AppButton>
              <AppButton data-mail-rules-confirm @click="confirmDiscard">Discard changes</AppButton>
            </div>
          </section>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.mail-rules {
  position: fixed;
  inset: 0;
  z-index: 125;
  display: grid;
  place-items: center;
  padding: 18px;
  background: color-mix(in srgb, #000 58%, transparent);
}
.mail-rules__panel {
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: min(900px, 100%);
  max-height: min(90vh, calc(100vh - 36px));
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--panel);
  color: var(--text);
  box-shadow: 0 24px 64px color-mix(in srgb, #000 45%, transparent);
}
.mail-rules__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--border-soft);
}
.mail-rules__header h2,
.mail-rules__confirm h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
}
.mail-rules__header p,
.mail-rules__confirm p,
.mail-rules__alert p {
  margin: 5px 0 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.45;
}
.mail-rules__body {
  overflow: auto;
  padding: 16px 20px 24px;
}
.mail-rules__mode-switch {
  display: inline-flex;
  gap: 2px;
  margin: 0 0 14px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel2);
}
.mail-rules__mode-switch button {
  min-width: 82px;
  padding: 6px 12px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
}
.mail-rules__mode-switch button[aria-pressed="true"] {
  background: var(--panel);
  color: var(--text);
  box-shadow: 0 1px 3px color-mix(in srgb, #000 22%, transparent);
}
.mail-rules__mode-switch button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent);
  outline-offset: 1px;
}
.mail-rules__mode-switch button:disabled {
  cursor: default;
  opacity: 0.55;
}
.mail-rules__toolbar,
.mail-rules__footer,
.mail-rule__header,
.mail-rule__section-title,
.mail-rules__summary,
.mail-rules__confirm-actions {
  display: flex;
  align-items: center;
}
.mail-rules__toolbar {
  justify-content: space-between;
  gap: 12px;
  margin: 4px 0 12px;
}
.mail-rules__summary {
  gap: 7px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
}
.mail-rules__footer {
  justify-content: flex-end;
  gap: 9px;
  padding: 12px 20px;
  border-top: 1px solid var(--border-soft);
  background: var(--panel2);
}
.mail-rules__footer-status {
  flex: 1;
  color: var(--muted);
  font-size: 12px;
}
.mail-rules__alert {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin: 0 0 14px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel2);
  font-size: 13px;
  line-height: 1.4;
}
.mail-rules__alert svg { flex: 0 0 auto; margin-top: 1px; }
.mail-rules__alert--warning {
  border-color: var(--warn-border);
  background: var(--warn-bg);
  color: var(--warn-fg);
}
.mail-rules__alert--error {
  border-color: color-mix(in srgb, #d33 55%, var(--border));
  background: color-mix(in srgb, #d33 10%, var(--panel));
}
.mail-rules__alert--success {
  border-color: color-mix(in srgb, #2b9b58 60%, var(--border));
  background: color-mix(in srgb, #2b9b58 10%, var(--panel));
}
.mail-rules__empty {
  margin: 28px 8px;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}
.mail-rules__fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.mail-rules__source {
  display: grid;
  gap: 9px;
}
.mail-rules__source-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  color: var(--text);
  font-size: 13px;
}
.mail-rules__source-heading span {
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mail-rules__source textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 430px;
  padding: 12px 14px;
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel2);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 1.55;
  tab-size: 2;
}
.mail-rules__source textarea:focus-visible {
  border-color: var(--accent);
  outline: 2px solid color-mix(in srgb, var(--accent) 30%, transparent);
  outline-offset: 1px;
}
.mail-rule {
  margin-bottom: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel2);
  overflow: visible;
}
.mail-rule__header {
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-soft);
}
.mail-rule__enabled {
  display: inline-flex;
  padding: 4px;
}
.mail-rule__name {
  flex: 1;
  min-width: 100px;
  font-weight: 600;
}
.mail-rule__section {
  padding: 12px;
}
.mail-rule__section + .mail-rule__section {
  border-top: 1px solid var(--border-soft);
}
.mail-rule__section-title {
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
.mail-rule__row {
  display: grid;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.mail-rule__condition {
  grid-template-columns: minmax(120px, 0.8fr) minmax(120px, 0.8fr) minmax(145px, 1fr) minmax(160px, 1.5fr) 32px;
}
.mail-rule__condition:not(:has(input[aria-label="Header name"])) {
  grid-template-columns: minmax(120px, 0.8fr) minmax(145px, 1fr) minmax(160px, 1.8fr) 32px;
}
.mail-rule__action {
  grid-template-columns: minmax(170px, 0.8fr) minmax(200px, 1.4fr) 32px;
}
.mail-rule__action-description {
  color: var(--muted);
  font-size: 13px;
}
.mail-rule__stop {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  color: var(--muted);
  font-size: 12px;
}
.mail-rule input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 34px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
  font-size: 13px;
}
.mail-rule input[type="checkbox"] {
  width: 16px;
  min-height: 16px;
  accent-color: var(--accent);
}
.mail-rule input:focus-visible {
  border-color: var(--accent);
  outline: 2px solid color-mix(in srgb, var(--accent) 30%, transparent);
  outline-offset: 1px;
}
.mail-rules__icon-button,
.mail-rules__text-button {
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
}
.mail-rules__icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 999px;
}
.mail-rules__icon-button:hover:not(:disabled),
.mail-rules__icon-button:focus-visible,
.mail-rules__text-button:hover,
.mail-rules__text-button:focus-visible {
  background: var(--rowHover);
  color: var(--text);
  outline: none;
}
.mail-rules__icon-button--danger:hover:not(:disabled),
.mail-rules__icon-button--danger:focus-visible { color: #d84a4a; }
.mail-rules__icon-button:disabled { opacity: 0.35; cursor: default; }
.mail-rules__text-button {
  padding: 5px 7px;
  border-radius: 4px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}
.mail-rules__confirm-backdrop {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: grid;
  place-items: center;
  padding: 16px;
  background: color-mix(in srgb, #000 62%, transparent);
}
.mail-rules__confirm {
  width: min(440px, 100%);
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: 0 20px 45px color-mix(in srgb, #000 45%, transparent);
}
.mail-rules__confirm-actions {
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@media (max-width: 760px) {
  .mail-rules { padding: 0; }
  .mail-rules__panel {
    width: 100%;
    height: 100%;
    max-height: none;
    border: 0;
    border-radius: 0;
  }
  .mail-rule__condition,
  .mail-rule__condition:not(:has(input[aria-label="Header name"])),
  .mail-rule__action {
    grid-template-columns: 1fr 32px;
  }
  .mail-rule__condition > :not(button),
  .mail-rule__action > :not(button) { grid-column: 1; }
  .mail-rule__condition > button,
  .mail-rule__action > button { grid-column: 2; grid-row: 1; }
  .mail-rules__footer { flex-wrap: wrap; }
  .mail-rules__footer-status { flex-basis: 100%; }
}
</style>
