<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import {
  Check,
  Save,
  Send as SendIcon,
  Trash2,
} from '@lucide/vue';

import {
  COMPOSE_PRESENTATION,
  RECIPIENT_FIELDS,
  useComposeStore,
  type ComposeSession,
  type RecipientEntry,
  type RecipientField,
} from '../stores/compose-store';
import { useModalFocus } from '../composables/useModalFocus';
import { getRepositoryAsync } from '../composables/useRepository';
import { useAuthStore } from '../stores/auth-store';
import { useContactsStore } from '../stores/contacts-store';
import { COMPOSE_STATE } from '../constants/states';
import type { ContactListRow, IdentityRow } from '../types/db';
import { senderAvatarStyle, senderInitials } from '../utils/sender-avatar';
import {
  IDENTITY_SIGNATURE_ORIGIN,
  type TrackedOriginState,
} from '../utils/compose-provenance';
import AppButton from './AppButton.vue';
import AppDropdown from './AppDropdown.vue';
import RecipientInput from './RecipientInput.vue';
import RichTextEditor from './RichTextEditor.vue';

const props = defineProps<{
  sessionId?: string;
}>();

const composeStore = useComposeStore();
const authStore = useAuthStore();
const contactsStore = useContactsStore();
const session = computed<ComposeSession | null>(() =>
  props.sessionId
    ? composeStore.sessionById(props.sessionId)
    : composeStore.activeSession);
const draft = computed(() => session.value?.draft ?? composeStore.draft);
const sessionStatus = computed(() => session.value?.status ?? COMPOSE_STATE.IDLE);
const sessionError = computed(() => session.value?.error ?? null);
const fromIdentity = computed(() => composeStore.identityForSession(session.value));
const isExpanded = computed(() =>
  session.value?.presentation === COMPOSE_PRESENTATION.EXPANDED);

function fieldId(field: RecipientField): string {
  return isExpanded.value ? `compose-${field}` : `compose-${session.value?.id}-${field}`;
}

const fromLabelId = computed(() =>
  isExpanded.value ? 'compose-from-label' : `compose-${session.value?.id}-from-label`);
const subjectInputId = computed(() =>
  isExpanded.value ? 'compose-subject' : `compose-${session.value?.id}-subject`);
const dialogTitleId = computed(() =>
  isExpanded.value ? 'compose-title' : `compose-${session.value?.id}-title`);
const closeTriggerLabel = computed(() =>
  session.value && composeStore.isSessionMeaningfullyNonEmpty(session.value.id)
    ? 'Close options'
    : 'Close');

const dialogEl = ref<HTMLElement | null>(null);
const closePromptEl = ref<HTMLElement | null>(null);
const closePromptOpen = computed(() => Boolean(session.value?.closePromptOpen));
useModalFocus(closePromptEl, {
  active: closePromptOpen,
  onDefault: saveClosePrompt,
});
const closeMenuTriggerEl = ref<HTMLElement | null>(null);
const richTextEditorEl = ref<{
  focus: () => void;
  setContent: (
    content: string,
    options?: { preserveFocus?: boolean },
  ) => { html: string; text: string };
  updateTrackedContent: (
    originId: string,
    content: string,
    options?: { preserveFocus?: boolean },
  ) => { html: string; text: string };
} | null>(null);
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'summary',
  '[contenteditable="true"]',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function saveClosePrompt(): void {
  const current = session.value;
  if (!current || current.isSaving) return;
  void composeStore.saveAndClose(current.id);
}

function updateDraftBody(content: { html: string; text: string }) {
  const currentSession = session.value;
  if (!currentSession) return;
  composeStore.setBodyContent(content, currentSession.id, { touch: false });
  composeStore.touchSession(currentSession.id);
}

function updateTrackedOrigins(states: TrackedOriginState[]) {
  composeStore.updateTrackedOrigins(states, session.value?.id ?? null);
}

/**
 * Close the <details> dropdown a picked item belongs to. A single-choice
 * menu that stays open after the choice reads as a menu that did not
 * work; <details> provides no close-on-activate of its own.
 */
function closeDropdown(event: Event) {
  const details = (event.currentTarget as HTMLElement).closest('details');
  if (details) details.open = false;
}

function activateCloseTrigger(event: MouseEvent) {
  const sessionId = session.value?.id;
  if (!sessionId || composeStore.isSessionMeaningfullyNonEmpty(sessionId)) return;
  event.preventDefault();
  composeStore.close(sessionId);
}

async function discardFromCloseMenu(event: Event) {
  const sessionId = session.value?.id;
  if (!sessionId) return;
  closeDropdown(event);
  if (!await composeStore.discardDraft(sessionId)) {
    await nextTick();
    closeMenuTriggerEl.value?.focus();
  }
}

async function saveFromCloseMenu(event: Event) {
  const sessionId = session.value?.id;
  if (!sessionId) return;
  closeDropdown(event);
  if (!await composeStore.saveAndClose(sessionId)) {
    await nextTick();
    closeMenuTriggerEl.value?.focus();
  }
}

/**
 * Where writing starts for this draft: the To field when it is empty (a
 * fresh message begins with addressing), the body when recipients came
 * prefilled (a reply or forward — addressing is done, prose is next).
 * Called after the open/remount tick, so the target exists.
 */
function focusFreshDraft() {
  if (!session.value || !isExpanded.value) return;
  if (draft.value.to.length === 0) {
    document.getElementById(fieldId('to'))?.focus();
  } else {
    richTextEditorEl.value?.focus();
  }
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => {
      if (element.closest('details:not([open])')) return false;
      if (element.closest('[hidden], [aria-hidden="true"]')) return false;
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
}

function trapDialogFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab') return;
  const container = session.value?.closePromptOpen ? closePromptEl.value : dialogEl.value;
  const focusable = focusableElements(container);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  const activeIsFocusable = active instanceof HTMLElement && focusable.includes(active);
  if (!activeIsFocusable) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

onMounted(() => {
  if (session.value) {
    void nextTick().then(() => {
      if (isExpanded.value) focusFreshDraft();
    });
  }
});

watch(() => session.value?.id, (nextId, previousId) => {
  if (nextId && nextId !== previousId) {
    void nextTick().then(() => {
      if (isExpanded.value) focusFreshDraft();
    });
  }
});

watch(() => session.value?.draftEpoch, (nextEpoch, previousEpoch) => {
  if (nextEpoch !== previousEpoch) void nextTick().then(focusFreshDraft);
});

watch(isExpanded, (expanded) => {
  if (expanded) void nextTick().then(focusFreshDraft);
});

watch(
  () => [session.value?.id, session.value?.bodyVersion] as const,
  ([nextId, nextVersion], [previousId, previousVersion]) => {
    if (!nextId || nextId !== previousId || nextVersion === previousVersion) return;
    void nextTick().then(() => {
      const current = session.value;
      if (!current || current.id !== nextId || current.bodyVersion !== nextVersion) return;
      richTextEditorEl.value?.updateTrackedContent(
        IDENTITY_SIGNATURE_ORIGIN,
        current.editorHtmlBody,
        { preserveFocus: true },
      );
    });
  },
);

// Draft exit actions are withheld while the send mutation is in flight:
// the queued request payload is the only durable copy of the message, so
// erasing the draft here could lose it if the send then fails.
const isSending = computed(() => sessionStatus.value === COMPOSE_STATE.SENDING);

/**
 * The committed recipients of each field, as the control shows them.
 *
 * Held here rather than read from the store on render because the order the
 * two kinds appear in is the control's: a fragment stays between the
 * addresses it was typed between, which the draft does not record. The
 * store keeps what the message carries and what refuses the send.
 */
const recipientEntries = reactive<Record<RecipientField, RecipientEntry[]>>({
  to: [],
  cc: [],
  bcc: [],
});

// Cc and Bcc stay out of the way until they hold something or are asked
// for: three empty fields on every new message is the reason they were
// left out in the first place.
const showCc = ref(false);
const showBcc = ref(false);

const RECIPIENT_LABELS: Record<RecipientField, string> = { to: 'To', cc: 'Cc', bcc: 'Bcc' };

const visibleRecipientFields = computed<RecipientField[]>(() => [
  'to',
  ...(showCc.value ? (['cc'] as const) : []),
  ...(showBcc.value ? (['bcc'] as const) : []),
]);

watch(
  () => [
    session.value?.id,
    session.value?.draftEpoch,
    session.value?.recipientVersion,
  ] as const,
  () => {
    const sessionId = session.value?.id;
    if (!sessionId) return;
    for (const field of RECIPIENT_FIELDS) {
      recipientEntries[field] = composeStore.recipientEntries(field, sessionId);
    }
    showCc.value = draft.value.cc.length > 0;
    showBcc.value = draft.value.bcc.length > 0;
  },
  { immediate: true },
);

function setEntries(field: RecipientField, entries: RecipientEntry[]) {
  recipientEntries[field] = entries;
  composeStore.setRecipientEntries(field, entries, session.value?.id ?? null);
}

/** Reveal Cc or Bcc and put the cursor in it. */
function revealField(field: 'cc' | 'bcc') {
  if (field === 'cc') showCc.value = true;
  else showBcc.value = true;
  void nextTick().then(() => document.getElementById(fieldId(field))?.focus());
}

/**
 * A Cc or Bcc left empty collapses when focus leaves the row, so an
 * unused field is not left open. focusout bubbles from the control's
 * input to this row; relatedTarget still inside the row means focus only
 * moved between the field and its own pills, which is not leaving.
 *
 * The empty check is deferred a tick because leaving the field also
 * commits any pending text, and a committed recipient must keep the
 * field open. To never hides.
 */
function onRecipientFocusOut(field: RecipientField, event: FocusEvent) {
  if (field === 'to') return;
  const row = event.currentTarget as HTMLElement | null;
  const next = event.relatedTarget as Node | null;
  if (row && next && row.contains(next)) return;
  void nextTick().then(() => {
    if (recipientEntries[field].length > 0) return;
    if (field === 'cc') showCc.value = false;
    else showBcc.value = false;
  });
}

/**
 * Addresses this message already carries in its other fields. Offering one
 * of them again spends a row of the list on a recipient who is already on
 * the message.
 */
function takenElsewhere(field: RecipientField): string[] {
  return RECIPIENT_FIELDS
    .filter((other) => other !== field)
    .flatMap((other) => draft.value[other].map((address) => address.email));
}

function queryContacts(prefix: string, limit: number, exclude: string[]) {
  return contactsStore.autocomplete(prefix, limit, exclude);
}

/**
 * The whole address book, for the browse path. The Contacts space is the
 * other place this list lives, and it is behind this dialog rather than
 * beside it, so the browse path stays in the field. No limit is passed:
 * CS-3.12 requires every contact to be selectable from the browse list.
 */
async function browseAllContacts() {
  const accountId = authStore.accountId;
  if (accountId == null) return [];
  const repo = await getRepositoryAsync();
  const contacts: ContactListRow[] = await repo.listContacts(accountId);
  return contacts
    .filter((contact) => !!contact.email)
    .map((contact) => ({
      ...(contact.display_name ? { name: contact.display_name } : {}),
      email: contact.email as string,
      source: 'contact' as const,
    }));
}

async function send() {
  await composeStore.send(session.value?.id ?? null);
}

function pickFromIdentity(idx: number, event: Event) {
  closeDropdown(event);
  composeStore.selectFromIndex(idx, session.value?.id ?? null);
}

function identityLabel(id: IdentityRow | null): string {
  if (!id) return '';
  return id.name ? `${id.name} <${id.email}>` : id.email;
}

/** The message list's sender circle, so one address is one color everywhere. */
function identityAvatarStyle(id: IdentityRow): Record<string, string> {
  return senderAvatarStyle(id.email);
}

function identityInitials(id: IdentityRow): string {
  return senderInitials(id.name?.trim() || id.email);
}
</script>

<template>
    <div
      v-if="session"
      v-show="isExpanded"
      ref="dialogEl"
      class="compose-dialog"
      :class="{ 'compose-dialog--expanded': isExpanded }"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="dialogTitleId"
      tabindex="-1"
      @keydown.capture="trapDialogFocus"
    >
    <div class="compose-dialog__card">
      <header>
        <h2 :id="dialogTitleId">{{ draft.subject || 'New Message' }}</h2>
        <div class="compose-dialog__window-actions">
          <button
            type="button"
            class="icon icon--minimize"
            :disabled="isSending || session.isSaving || session.isDiscarding"
            :title="isSending ? 'Sending — please wait' : 'Minimize'"
            aria-label="Minimize"
            @click="composeStore.minimize(session.id)"
          >−</button>
          <AppDropdown
            class="compose-close-menu"
            :disabled="isSending || session.isDiscarding"
          >
            <summary
              ref="closeMenuTriggerEl"
              class="icon compose-close-menu__trigger"
              role="button"
              aria-haspopup="menu"
              :title="isSending ? 'Sending — please wait' : closeTriggerLabel"
              :aria-label="closeTriggerLabel"
              :aria-disabled="isSending || session.isDiscarding
                ? 'true'
                : undefined"
              :tabindex="isSending || session.isDiscarding ? -1 : undefined"
              @click="activateCloseTrigger"
            >×</summary>
            <div
              class="app-dropdown__menu compose-close-menu__menu"
              role="menu"
              aria-label="Close options"
            >
              <button
                type="button"
                class="app-dropdown__item compose-close-menu__discard"
                role="menuitem"
                :disabled="isSending || session.isDiscarding"
                @click="discardFromCloseMenu"
              >
                <Trash2 :size="15" aria-hidden="true" />
                <span>Discard</span>
              </button>
              <button
                type="button"
                class="app-dropdown__item"
                role="menuitem"
                :disabled="isSending || session.isSaving || session.isDiscarding"
                @click="saveFromCloseMenu"
              >
                <Save :size="15" aria-hidden="true" />
                <span>Save Draft</span>
              </button>
            </div>
          </AppDropdown>
        </div>
      </header>

      <div class="row">
        <label :id="fromLabelId">From</label>
        <!-- An identity is a person with an address, so its rows wear the
             same avatar-and-two-lines dress the suggestion list and the
             message list use: one look for one kind of thing. -->
        <AppDropdown class="from-picker" data-compose-from>
          <summary
            class="app-dropdown__summary from-picker__summary"
            :aria-labelledby="fromLabelId"
          >
            <span
              v-if="fromIdentity"
              class="from-picker__avatar"
              aria-hidden="true"
              :style="identityAvatarStyle(fromIdentity)"
            >{{ identityInitials(fromIdentity) }}</span>
            <span class="from-picker__summary-text">
              {{ session.unresolvedFrom
                ? `Unavailable identity: ${session.unresolvedFrom.email}`
                : identityLabel(fromIdentity) }}
            </span>
          </summary>
          <div class="app-dropdown__menu from-picker__menu" role="menu" aria-label="From identity">
            <button
              v-for="(id, idx) in composeStore.identities"
              :key="id.id"
              type="button"
              class="app-dropdown__item from-picker__option"
              role="menuitemradio"
              :aria-checked="idx === draft.fromIdx"
              @click="pickFromIdentity(idx, $event)"
            >
              <span
                class="from-picker__avatar"
                aria-hidden="true"
                :style="identityAvatarStyle(id)"
              >{{ identityInitials(id) }}</span>
              <span class="from-picker__lines">
                <span v-if="id.name" class="from-picker__name">{{ id.name }}</span>
                <span class="from-picker__email" :class="{ 'from-picker__email--primary': !id.name }">
                  {{ id.email }}
                </span>
              </span>
              <Check v-if="idx === draft.fromIdx" :size="15" class="from-picker__check" />
            </button>
          </div>
        </AppDropdown>
      </div>

      <!-- Remounted per draft: the control owns the text being typed, and a
           reply that replaces the draft has to replace that too. -->
      <div
        v-for="field in visibleRecipientFields"
        :key="field"
        class="row row--recipient"
        :class="{ 'row--to': field === 'to' }"
        @focusout="onRecipientFocusOut(field, $event)"
      >
        <label :for="fieldId(field)">{{ RECIPIENT_LABELS[field] }}</label>
        <RecipientInput
          :key="`${session.id}-${field}-${session.draftEpoch}`"
          :input-id="fieldId(field)"
          :label="RECIPIENT_LABELS[field]"
          :entries="recipientEntries[field]"
          :taken="takenElsewhere(field)"
          :query="queryContacts"
          :browse-all="browseAllContacts"
          @update:entries="(entries: RecipientEntry[]) => setEntries(field, entries)"
          @update:pending-text="(value: string) =>
            composeStore.setPendingRecipientText(field, value, session.id)"
        />
        <!-- Cc/Bcc live at the right of To, both offered at once. Each
             reveals its field; an empty field hides again on blur, so the
             toggle returns. -->
        <div v-if="field === 'to'" class="recipient-cc-toggles">
          <button
            v-if="!showCc"
            type="button"
            class="recipient-toggle"
            @click="revealField('cc')"
          >Cc</button>
          <button
            v-if="!showBcc"
            type="button"
            class="recipient-toggle"
            @click="revealField('bcc')"
          >Bcc</button>
        </div>
      </div>

      <div class="row">
        <label :for="subjectInputId">Subject</label>
        <input
          :id="subjectInputId"
          type="text"
          v-model="draft.subject"
          @input="composeStore.touchSession(session.id)"
        />
      </div>

      <RichTextEditor
        ref="richTextEditorEl"
        :content-key="session.id"
        :initial-html="session.editorHtmlBody"
        accessible-label="Message body"
        @tracked-origin-state="updateTrackedOrigins"
        @update="updateDraftBody"
      />

      <footer>
        <AppButton
          :disabled="isSending || session.isDiscarding"
          @click="send"
        >
          <template #iconLeft>
            <SendIcon
              :size="16"
              :stroke-width="2"
              aria-hidden="true"
            />
          </template>
          {{ isSending ? 'Sending…' : 'Send' }}
        </AppButton>
      </footer>

      <p
        v-if="session.saveError && session.saveError !== sessionError"
        class="compose-save-error"
        role="status"
        aria-live="polite"
      >{{ session.saveError }}</p>

      <!-- role="alert" carries an implicit assertive live region, which is
           announced on insertion. The element is conditional because the
           card is a flex column with a gap, and a permanently rendered
           container would hold that gap open under the footer whenever
           there is no error. -->
      <p
        v-if="sessionError"
        class="compose-error"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >{{ sessionError }}</p>

      <div
        v-if="session.closePromptOpen"
        class="compose-confirm-backdrop"
      >
        <section
          ref="closePromptEl"
          class="compose-confirm"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="compose-close-title"
          aria-describedby="compose-close-description"
          tabindex="-1"
        >
          <h3
            id="compose-close-title"
          >Save this draft?</h3>
          <p id="compose-close-description">
            Save your latest changes before closing this compose window.
          </p>
          <div class="compose-confirm__actions">
            <AppButton
              variant="outline"
              @click="composeStore.cancelClose(session.id)"
            >Cancel</AppButton>
            <AppButton
              variant="outline"
              @click="composeStore.closeWithoutSaving(session.id)"
            >Don't Save</AppButton>
            <AppButton
              :disabled="session.isSaving"
              @click="composeStore.saveAndClose(session.id)"
            >Save draft</AppButton>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.compose-dialog {
  position: fixed;
  inset: 0;
  background: rgba(13, 22, 42, 0.4);
  display: grid;
  place-items: center;
  z-index: 50;
}
.compose-dialog__card {
  position: relative;
  width: min(960px, 96vw);
  height: min(640px, 90vh);
  background: var(--surface, #fff);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  padding: 16px;
  gap: 8px;
}
.compose-dialog__card header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.compose-dialog__card header h2 { margin: 0; font-size: 16px; }
.compose-dialog__window-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.icon {
  background: transparent;
  border: 0;
  font-size: 24px;
  cursor: pointer;
  color: inherit;
}
.icon--minimize {
  font-size: 20px;
}
.compose-close-menu__trigger {
  display: grid;
  place-items: center;
  list-style: none;
}
.compose-close-menu__trigger::-webkit-details-marker {
  display: none;
}
.compose-close-menu__menu {
  top: calc(100% + 1px);
  right: 0;
  left: auto;
  min-width: 160px;
  line-height: normal;
}
.compose-close-menu__menu .app-dropdown__item:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.compose-close-menu__discard:hover:not(:disabled),
.compose-close-menu__discard:focus-visible {
  color: #ff6b6b;
}
.row {
  display: grid;
  grid-template-columns: 70px 1fr;
  gap: 8px;
  align-items: center;
  font-size: var(--txt-default, 0.875rem);
}
.row label {
  color: var(--colour-ti-secondary, var(--text, #111827));
  font-size: inherit;
}
.row input {
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
  font: inherit;
}
.from-picker {
  min-width: 0;
}
/* The field look of .row input, on a summary; the chevron rides the
   right edge. */
.from-picker__summary {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
  padding: 5px 10px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
  background: var(--panel, transparent);
}
.from-picker__summary::after {
  margin-left: auto;
}
.from-picker__summary-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Full row width: an identity line is long, a 190px panel is not. */
.from-picker__menu {
  right: 0;
}
/* Person rows: avatar, the two lines, and the check on the selected
   one — the suggestion list's shape. */
.from-picker__option {
  grid-template-columns: 24px 1fr auto;
}
.from-picker__avatar {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 999px;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  flex: none;
}
.from-picker__summary .from-picker__avatar {
  width: 20px;
  height: 20px;
  font-size: 9px;
}
.from-picker__lines {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.from-picker__name {
  font-weight: 600;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.from-picker__email {
  font-size: 12px;
  line-height: 1.3;
  color: var(--muted, #6b7280);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.from-picker__email--primary {
  font-size: inherit;
  color: inherit;
  font-weight: 600;
}
.from-picker__check {
  flex: none;
  color: var(--accent, #0060df);
}
/* The To row carries the Cc/Bcc toggles in a third, content-width column
   at its right edge; the label column stays 70px so every row aligns. */
.row--to {
  grid-template-columns: 70px 1fr auto;
}
.recipient-cc-toggles {
  display: flex;
  gap: 4px;
}
.recipient-toggle {
  padding: 4px 8px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 6px;
  background: none;
  color: var(--colour-ti-secondary, var(--text, #111827));
  font: inherit;
  cursor: pointer;
}
.recipient-toggle:hover {
  color: var(--text, inherit);
  border-color: var(--accent, #0060df);
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.compose-error { color: #b3261e; font-size: 13px; }
.compose-save-error {
  margin: 0;
  color: var(--colour-ti-warning, #8a4b00);
  font-size: var(--txt-small, 0.8125rem);
}
.compose-confirm-backdrop {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: grid;
  place-items: center;
  padding: 16px;
  border-radius: inherit;
  background: rgba(13, 22, 42, 0.48);
}
.compose-confirm {
  width: min(420px, 100%);
  padding: 20px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 12px;
  background: var(--surface, #fff);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
}
.compose-confirm h3 {
  margin: 0 0 8px;
  font-size: var(--txt-large, 1rem);
}
.compose-confirm h3:focus {
  outline: none;
}
.compose-confirm p {
  margin: 0 0 20px;
  color: var(--colour-ti-secondary, var(--text, #111827));
}
.compose-confirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
