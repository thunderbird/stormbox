<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import {
  Check,
  ChevronDown,
  Paperclip,
  RotateCw,
  Save,
  Send as SendIcon,
  Trash2,
  X,
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
import { useContactsStore } from '../stores/contacts-store';
import { useSettingsStore } from '../stores/settings-store';
import { COMPOSE_STATE } from '../constants/states';
import type { IdentityRow } from '../types/db';
import { sanitizeAttachmentFilename } from '../utils/attachment-presentation';
import { closeContainingDropdown } from '../utils/dropdown';
import { senderAvatarStyle, senderInitials } from '../utils/sender-avatar';
import { formatBytes } from '../utils/format-bytes';
import {
  SCHEDULE_PRESETS,
  formatScheduleTarget,
  resolveSchedulePreset,
  resolveSchedulePresets,
  type SchedulePresetId,
  type SchedulePresetResolution,
} from '../utils/schedule-time';
import {
  IDENTITY_SIGNATURE_ORIGIN,
  type TrackedOriginState,
} from '../utils/compose-provenance';
import AppButton from './AppButton.vue';
import AppDropdown from './AppDropdown.vue';
import AppIconButton from './AppIconButton.vue';
import RecipientInput from './RecipientInput.vue';
import RichTextEditor from './RichTextEditor.vue';
import ScheduleSendDialog from './ScheduleSendDialog.vue';

const props = defineProps<{
  sessionId?: string;
}>();

const composeStore = useComposeStore();
const contactsStore = useContactsStore();
const settingsStore = useSettingsStore();
const session = computed<ComposeSession | null>(() =>
  props.sessionId
    ? composeStore.sessionById(props.sessionId)
    : composeStore.activeSession);
const draft = computed(() => session.value?.draft ?? composeStore.draft);
const sessionStatus = computed(() => session.value?.status ?? COMPOSE_STATE.IDLE);
const sessionError = computed(() => session.value?.error ?? null);
const isSending = computed(() => sessionStatus.value === COMPOSE_STATE.SENDING);
const attachments = computed(() => session.value?.attachments ?? []);
const uncheckpointedAttachmentCount = computed(() =>
  session.value ? composeStore.uncheckpointedAttachmentCount(session.value.id) : 0);
const attachmentBusy = computed(() =>
  session.value ? composeStore.isAttachmentBusy(session.value.id) : false);
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
const attachmentInputEl = ref<HTMLInputElement | null>(null);
const scheduleMenuTriggerEl = ref<HTMLElement | null>(null);
const customScheduleOpen = ref(false);
const capabilityRefreshing = ref(false);
const capabilityChecked = ref(false);
const isScheduling = ref(false);
const scheduleUiError = ref<string | null>(null);
const customScheduleError = ref<string | null>(null);
interface StagedSchedule {
  targetAt: string;
  timeZone: string;
  resolvedLabel: string;
  optionLabel: string;
}
const stagedSchedule = ref<StagedSchedule | null>(null);
const schedulePresets = ref<SchedulePresetResolution[]>(
  SCHEDULE_PRESETS.map((preset) => ({
    ...preset,
    available: false,
    targetAt: null,
    resolvedLabel: null,
    reason: 'capabilityUnavailable',
    message: 'Checking whether scheduled sending is available.',
  })),
);
let capabilityRefreshGeneration = 0;
let scheduleActionGeneration = 0;
const closePromptOpen = computed(() => Boolean(session.value?.closePromptOpen));
useModalFocus(dialogEl, {
  containTab: true,
  focusOnActivate: false,
  resolveContainer: () => (
    closePromptOpen.value ? closePromptEl.value : dialogEl.value
  ),
});
useModalFocus(closePromptEl, {
  active: closePromptOpen,
  onDefault: saveClosePrompt,
});
const closeMenuTriggerEl = ref<HTMLElement | null>(null);
const selectedTimeZone = computed(() => settingsStore.get('timeZone'));
const scheduleBusy = computed(() => isSending.value || isScheduling.value);
const scheduleChoiceDisabled = computed(() =>
  scheduleBusy.value
  || !capabilityChecked.value
  || !composeStore.canScheduleSend);
const scheduleSegmentDisabled = computed(() =>
  scheduleBusy.value
  || (!stagedSchedule.value && scheduleChoiceDisabled.value));
const sendButtonText = computed(() => {
  if (isScheduling.value) return 'Scheduling…';
  if (isSending.value) return 'Sending…';
  return 'Send';
});
const scheduleTriggerLabel = computed(() => stagedSchedule.value
  ? `Schedule send: ${stagedSchedule.value.optionLabel}`
  : 'Schedule send');
const scheduleTriggerTitle = computed(() => stagedSchedule.value
  ? `${stagedSchedule.value.optionLabel} — ${stagedSchedule.value.resolvedLabel}`
  : 'Schedule send');
const scheduleDescriptionId = computed(() =>
  `compose-${session.value?.id ?? 'inactive'}-schedule-description`);
const scheduleAvailabilityMessage = computed(() => {
  if (isScheduling.value) return 'Scheduling this message.';
  if (stagedSchedule.value) {
    return `Selected ${stagedSchedule.value.resolvedLabel}. `
      + 'Click Send to schedule this message.';
  }
  if (capabilityRefreshing.value || !capabilityChecked.value) {
    return 'Checking whether scheduled sending is available.';
  }
  if (!composeStore.canScheduleSend) {
    return 'Scheduled sending is not supported by this account. Immediate Send is still available.';
  }
  return `Scheduled sending uses ${selectedTimeZone.value}.`;
});
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

interface PastedEditorFile {
  file: File;
  kind: 'inline' | 'attachment';
}

function openAttachmentPicker(): void {
  attachmentInputEl.value?.click();
}

async function pickAttachments(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  input.value = '';
  if (files.length === 0 || !session.value) return;
  await composeStore.addAttachments(files, 'picker', session.value.id);
}

async function attachPastedFiles(files: PastedEditorFile[]): Promise<void> {
  const regular = files
    .filter((entry) => entry.kind === 'attachment')
    .map((entry) => entry.file);
  if (regular.length === 0 || !session.value) return;
  await composeStore.addAttachments(regular, 'paste', session.value.id);
}

function attachmentSize(size: number): string {
  return formatBytes(size) ?? `${size} B`;
}

function attachmentDisplayName(name: string): string {
  return sanitizeAttachmentFilename(name);
}

function closeScheduleMenu(): void {
  closeContainingDropdown(scheduleMenuTriggerEl.value);
}

function refreshResolvedPresets(): void {
  schedulePresets.value = resolveSchedulePresets({
    now: Date.now(),
    timeZone: selectedTimeZone.value,
    maxDelayedSend: composeStore.scheduleMaxDelayedSend,
    serverClockReference: composeStore.scheduleCapability.serverClockReference,
  });
}

async function refreshScheduleCapabilityForSession(
  expectedSessionId = session.value?.id,
): Promise<void> {
  if (!expectedSessionId) return;
  const generation = ++capabilityRefreshGeneration;
  capabilityRefreshing.value = true;
  const capability = await composeStore.refreshScheduleCapability();
  if (
    generation !== capabilityRefreshGeneration
    || session.value?.id !== expectedSessionId
  ) {
    return;
  }
  capabilityRefreshing.value = false;
  capabilityChecked.value = true;
  refreshResolvedPresets();
  if (!capability.supported && !stagedSchedule.value) closeScheduleMenu();
}

function onScheduleMenuToggle(event: Event): void {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.open) return;
  scheduleUiError.value = null;
  void refreshScheduleCapabilityForSession();
}

function stageScheduleTarget(
  targetAt: string,
  timeZone: string,
  optionLabel: string,
): void {
  const current = session.value;
  if (!current || scheduleChoiceDisabled.value) return;
  scheduleUiError.value = null;
  customScheduleError.value = null;
  stagedSchedule.value = {
    targetAt,
    timeZone,
    resolvedLabel: formatScheduleTarget(targetAt, timeZone),
    optionLabel,
  };
  closeScheduleMenu();
  customScheduleOpen.value = false;
  void nextTick(() =>
    dialogEl.value?.querySelector<HTMLButtonElement>('.compose-send')?.focus());
}

function clearStagedSchedule(event: Event): void {
  closeContainingDropdown(event);
  stagedSchedule.value = null;
  scheduleUiError.value = null;
}

function pickSchedulePreset(id: SchedulePresetId): void {
  if (scheduleChoiceDisabled.value) return;
  const current = resolveSchedulePreset(id, {
    now: Date.now(),
    timeZone: selectedTimeZone.value,
    maxDelayedSend: composeStore.scheduleMaxDelayedSend,
    serverClockReference: composeStore.scheduleCapability.serverClockReference,
  });
  if (!current.available || !current.targetAt) {
    scheduleUiError.value = current.message ?? 'Choose another scheduled time.';
    refreshResolvedPresets();
    return;
  }
  stageScheduleTarget(current.targetAt, selectedTimeZone.value, current.label);
}

function stageCustomScheduleTarget(targetAt: string, timeZone: string): void {
  stageScheduleTarget(targetAt, timeZone, 'Custom');
}

function openCustomSchedule(event: Event): void {
  if (scheduleChoiceDisabled.value) return;
  closeContainingDropdown(event);
  scheduleUiError.value = null;
  customScheduleError.value = null;
  customScheduleOpen.value = true;
}

function closeCustomSchedule(): void {
  if (!isScheduling.value) {
    customScheduleOpen.value = false;
    void nextTick(() => scheduleMenuTriggerEl.value?.focus());
  }
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
  closeContainingDropdown(event);
  if (!await composeStore.discardDraft(sessionId)) {
    await nextTick();
    closeMenuTriggerEl.value?.focus();
  }
}

async function saveFromCloseMenu(event: Event) {
  const sessionId = session.value?.id;
  if (!sessionId) return;
  closeContainingDropdown(event);
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

onMounted(() => {
  if (session.value && isExpanded.value) {
    void refreshScheduleCapabilityForSession(session.value.id);
    void nextTick().then(() => {
      if (isExpanded.value) focusFreshDraft();
    });
  }
});

watch(() => session.value?.id, (nextId, previousId) => {
  if (nextId && nextId !== previousId) {
    scheduleActionGeneration += 1;
    capabilityRefreshGeneration += 1;
    customScheduleOpen.value = false;
    capabilityChecked.value = false;
    capabilityRefreshing.value = false;
    isScheduling.value = false;
    scheduleUiError.value = null;
    customScheduleError.value = null;
    stagedSchedule.value = null;
    void refreshScheduleCapabilityForSession(nextId);
    void nextTick().then(() => {
      if (isExpanded.value) focusFreshDraft();
    });
  }
});

watch(() => session.value?.draftEpoch, (nextEpoch, previousEpoch) => {
  if (nextEpoch !== previousEpoch) void nextTick().then(focusFreshDraft);
});

watch(isExpanded, (expanded) => {
  if (expanded) {
    void refreshScheduleCapabilityForSession();
    void nextTick().then(focusFreshDraft);
  } else {
    customScheduleOpen.value = false;
    closeScheduleMenu();
  }
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
  return contactsStore.browseAutocompleteCandidates();
}

async function send() {
  if (isScheduling.value) return;
  const current = session.value;
  const schedule = stagedSchedule.value;
  if (!current || !schedule) {
    await composeStore.send(current?.id ?? null);
    return;
  }
  const actionGeneration = ++scheduleActionGeneration;
  isScheduling.value = true;
  scheduleUiError.value = null;
  try {
    const scheduled = await composeStore.scheduleSend(
      current.id,
      schedule.targetAt,
      schedule.timeZone,
    );
    if (
      actionGeneration === scheduleActionGeneration
      && session.value?.id === current.id
      && !scheduled
    ) {
      scheduleUiError.value = sessionError.value
        ?? 'Could not schedule this message. Try another time.';
    }
  } finally {
    if (actionGeneration === scheduleActionGeneration) {
      isScheduling.value = false;
    }
  }
}

function pickFromIdentity(idx: number, event: Event) {
  closeContainingDropdown(event);
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
      :aria-hidden="customScheduleOpen ? 'true' : undefined"
      tabindex="-1"
    >
    <div class="compose-dialog__card">
      <header>
        <h2 :id="dialogTitleId">{{ draft.subject || 'New Message' }}</h2>
        <div class="compose-dialog__window-actions">
          <button
            type="button"
            class="icon icon--minimize"
            :disabled="scheduleBusy || session.isSaving || session.isDiscarding"
            :title="isScheduling
              ? 'Scheduling — please wait'
              : (isSending ? 'Sending — please wait' : 'Minimize')"
            aria-label="Minimize"
            @click="composeStore.minimize(session.id)"
          >−</button>
          <AppDropdown
            class="compose-close-menu"
            :disabled="scheduleBusy || session.isDiscarding"
          >
            <summary
              ref="closeMenuTriggerEl"
              class="icon compose-close-menu__trigger"
              role="button"
              aria-haspopup="menu"
              :title="isScheduling
                ? 'Scheduling — please wait'
                : (isSending ? 'Sending — please wait' : closeTriggerLabel)"
              :aria-label="closeTriggerLabel"
              :aria-disabled="scheduleBusy || session.isDiscarding
                ? 'true'
                : undefined"
              :tabindex="scheduleBusy || session.isDiscarding ? -1 : undefined"
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
                :disabled="scheduleBusy || session.isDiscarding"
                @click="discardFromCloseMenu"
              >
                <Trash2 :size="15" aria-hidden="true" />
                <span>Discard</span>
              </button>
              <button
                type="button"
                class="app-dropdown__item"
                role="menuitem"
                :disabled="scheduleBusy || session.isSaving || session.isDiscarding"
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
        @paste-files="attachPastedFiles"
      />

      <section
        v-if="attachments.length > 0"
        class="compose-attachments"
        aria-label="Attachments"
      >
        <article
          v-for="attachment in attachments"
          :key="attachment.clientId"
          class="compose-attachment"
        >
          <div class="compose-attachment__details">
            <strong class="compose-attachment__name">
              {{ attachmentDisplayName(attachment.name) }}
            </strong>
            <span class="compose-attachment__meta">
              {{ attachmentSize(attachment.size) }}
              <template v-if="attachment.status === 'ready'"> · Ready</template>
              <template v-else-if="attachment.status === 'failed'"> · Upload failed</template>
            </span>
            <div
              v-if="attachment.status === 'uploading'"
              class="compose-attachment__progress"
            >
              <progress
                :value="attachment.progress"
                max="100"
                :aria-label="`Uploading ${attachmentDisplayName(attachment.name)}: ${attachment.progress}%`"
              />
              <span>{{ attachment.progress }}%</span>
            </div>
            <span
              v-if="attachment.error"
              class="compose-attachment__error"
              role="status"
            >{{ attachment.error }}</span>
          </div>
          <div class="compose-attachment__actions">
            <AppIconButton
              v-if="attachment.status === 'failed'"
              class="compose-attachment__action"
              :aria-label="`Retry ${attachmentDisplayName(attachment.name)}`"
              :title="`Retry ${attachmentDisplayName(attachment.name)}`"
              @click="composeStore.retryAttachment(attachment.clientId, session.id)"
            >
              <RotateCw :size="15" aria-hidden="true" />
            </AppIconButton>
            <AppIconButton
              v-if="attachment.status === 'uploading'"
              class="compose-attachment__action"
              :aria-label="`Cancel upload of ${attachmentDisplayName(attachment.name)}`"
              :title="`Cancel upload of ${attachmentDisplayName(attachment.name)}`"
              @click="composeStore.cancelAttachment(attachment.clientId, session.id)"
            >
              <X :size="15" aria-hidden="true" />
            </AppIconButton>
            <AppIconButton
              class="compose-attachment__action"
              :aria-label="`Remove ${attachmentDisplayName(attachment.name)}`"
              :title="`Remove ${attachmentDisplayName(attachment.name)}`"
              @click="composeStore.removeAttachment(attachment.clientId, session.id)"
            >
              <Trash2 :size="15" aria-hidden="true" />
            </AppIconButton>
          </div>
        </article>
      </section>

      <p
        v-if="uncheckpointedAttachmentCount > 0"
        class="compose-attachment-warning"
        role="status"
      >
        {{ uncheckpointedAttachmentCount === 1
          ? '1 attachment has not reached the draft yet.'
          : `${uncheckpointedAttachmentCount} attachments have not reached the draft yet.` }}
      </p>

      <footer>
        <input
          ref="attachmentInputEl"
          type="file"
          multiple
          hidden
          @change="pickAttachments"
        />
        <AppButton
          variant="outline"
          :disabled="scheduleBusy || session.isDiscarding"
          aria-label="Attach files"
          title="Attach files"
          @click="openAttachmentPicker"
        >
          <template #iconLeft>
            <Paperclip :size="17" aria-hidden="true" />
          </template>
          Attach
        </AppButton>
        <div class="compose-send-split">
          <AppButton
            class="compose-send"
            :disabled="scheduleBusy
              || session.isDiscarding
              || attachmentBusy
              || Boolean(stagedSchedule && scheduleChoiceDisabled)"
            @click="send"
          >
            <template #iconLeft>
              <SendIcon
                :size="16"
                :stroke-width="2"
                aria-hidden="true"
              />
            </template>
            {{ sendButtonText }}
          </AppButton>
          <AppDropdown
            class="compose-schedule-menu"
            :disabled="scheduleSegmentDisabled"
            @toggle="onScheduleMenuToggle"
          >
            <summary
              ref="scheduleMenuTriggerEl"
              class="compose-schedule-menu__trigger"
              :class="{ 'compose-schedule-menu__trigger--selected': stagedSchedule }"
              role="button"
              aria-haspopup="menu"
              :aria-label="scheduleTriggerLabel"
              :title="scheduleTriggerTitle"
              :aria-describedby="scheduleDescriptionId"
              :aria-busy="isScheduling ? 'true' : undefined"
              :aria-disabled="scheduleSegmentDisabled ? 'true' : undefined"
              :tabindex="scheduleSegmentDisabled ? -1 : undefined"
            >
              <span
                v-if="stagedSchedule"
                class="compose-schedule-menu__selection"
              >{{ stagedSchedule.optionLabel }}</span>
              <ChevronDown :size="16" :stroke-width="2" aria-hidden="true" />
            </summary>
            <div
              class="app-dropdown__menu compose-schedule-menu__menu"
              role="menu"
              aria-label="Schedule send"
            >
              <button
                v-if="stagedSchedule"
                type="button"
                class="app-dropdown__item compose-schedule-menu__item"
                role="menuitem"
                :disabled="scheduleBusy"
                @click="clearStagedSchedule"
              >
                <span class="compose-schedule-menu__label">Send now</span>
                <span class="compose-schedule-menu__secondary">Immediately</span>
              </button>
              <div
                v-if="stagedSchedule"
                class="compose-schedule-menu__separator"
                role="separator"
              />
              <button
                v-for="preset in schedulePresets"
                :key="preset.id"
                type="button"
                class="app-dropdown__item compose-schedule-menu__item"
                role="menuitem"
                :disabled="scheduleChoiceDisabled || !preset.available"
                :title="preset.available
                  ? (preset.resolvedLabel ?? undefined)
                  : (preset.message ?? undefined)"
                @click="pickSchedulePreset(preset.id)"
              >
                <span class="compose-schedule-menu__label">{{ preset.label }}</span>
                <span class="compose-schedule-menu__secondary">
                  {{ preset.available ? preset.resolvedLabel : preset.message }}
                </span>
              </button>
              <div class="compose-schedule-menu__separator" role="separator" />
              <button
                type="button"
                class="app-dropdown__item compose-schedule-menu__item"
                role="menuitem"
                :disabled="scheduleChoiceDisabled"
                @click="openCustomSchedule"
              >
                <span class="compose-schedule-menu__label">Choose a date and time</span>
              </button>
            </div>
          </AppDropdown>
          <span :id="scheduleDescriptionId" class="compose-schedule-menu__description">
            {{ scheduleAvailabilityMessage }}
          </span>
        </div>
      </footer>

      <ScheduleSendDialog
        v-if="customScheduleOpen"
        :busy="isScheduling"
        :error="customScheduleError"
        :max-delayed-send="composeStore.scheduleMaxDelayedSend"
        :server-clock-reference="composeStore.scheduleCapability.serverClockReference"
        :session-id="session.id"
        :time-zone="selectedTimeZone"
        @clear-error="customScheduleError = null"
        @close="closeCustomSchedule"
        @select="stageCustomScheduleTarget"
      />

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
        v-if="scheduleUiError"
        class="compose-error"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >{{ scheduleUiError }}</p>

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
            {{ uncheckpointedAttachmentCount > 0
              ? 'Some attachments have not reached the draft. Keep this window open to finish '
                + 'or retry them, or close without saving those attachments.'
              : 'Save your latest changes before closing this compose window.' }}
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
.compose-attachments {
  display: grid;
  max-height: 150px;
  overflow-y: auto;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
}
.compose-attachment {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding: 8px 10px;
}
.compose-attachment + .compose-attachment {
  border-top: 1px solid var(--border, #d6d9e2);
}
.compose-attachment__details {
  display: grid;
  min-width: 0;
  gap: 2px;
}
.compose-attachment__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--txt-default, 0.875rem);
}
.compose-attachment__meta,
.compose-attachment__error,
.compose-attachment__progress,
.compose-attachment-warning {
  font-size: var(--txt-small, 0.75rem);
}
.compose-attachment__meta {
  color: var(--colour-ti-secondary, var(--muted, #6b7280));
}
.compose-attachment__error,
.compose-attachment-warning {
  color: var(--colour-ti-warning, #8a4b00);
}
.compose-attachment__progress {
  display: flex;
  align-items: center;
  gap: 8px;
}
.compose-attachment__progress progress {
  width: min(220px, 40vw);
}
.compose-attachment__actions {
  display: flex;
  gap: 4px;
  flex: none;
}
.compose-attachment__action {
  width: 32px;
  height: 32px;
  flex-basis: 32px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 7px;
  color: inherit;
}
.compose-attachment__action:hover {
  border-color: var(--accent, #0060df);
}
.compose-attachment-warning {
  margin: 0;
}
footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}
.compose-send-split {
  position: relative;
  display: inline-flex;
  align-items: stretch;
  gap: 0;
}
.compose-send-split .compose-schedule-menu {
  position: static;
}
.compose-schedule-menu__trigger {
  position: relative;
  z-index: 1;
  display: inline-flex;
  width: 34px;
  height: 34px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-left: 1px solid color-mix(in srgb, #fff 42%, transparent);
  border-radius: 0 4px 4px 0;
  background: var(--colour-primary-default, var(--accent, #0060df));
  color: var(--colour-ti-on-primary, #fff);
  cursor: pointer;
  list-style: none;
}
.compose-schedule-menu__trigger--selected {
  width: auto;
  min-width: 34px;
  gap: 4px;
  padding: 0 8px 0 10px;
}
.compose-schedule-menu__selection {
  max-width: 112px;
  overflow: hidden;
  font-size: var(--txt-small, 0.75rem);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.compose-schedule-menu__trigger::-webkit-details-marker {
  display: none;
}
.compose-schedule-menu__trigger:hover:not([aria-disabled='true']) {
  background: var(--colour-primary-hover, #0250bb);
}
.compose-schedule-menu__trigger:active:not([aria-disabled='true']) {
  background: var(--colour-primary-pressed, #054096);
}
.compose-schedule-menu__trigger:focus:not(:focus-visible) {
  outline: none;
}
.compose-schedule-menu__trigger:focus-visible {
  z-index: 2;
  outline: 2px solid var(--accent, #0060df);
  outline-offset: 2px;
}
.compose-schedule-menu__trigger[aria-disabled='true'] {
  cursor: not-allowed;
  opacity: 0.55;
}
.compose-send-split .base.app-button.compose-send {
  border-radius: 4px 0 0 4px;
}
.compose-schedule-menu__menu {
  top: auto;
  right: 0;
  bottom: calc(100% + 6px);
  left: auto;
  width: min(340px, calc(100vw - 32px));
  min-width: 290px;
}
.compose-schedule-menu__item {
  grid-template-columns: 1fr;
  gap: 1px;
}
.compose-schedule-menu__item:disabled {
  cursor: not-allowed;
  opacity: 0.58;
}
.compose-schedule-menu__label {
  font-weight: 600;
}
.compose-schedule-menu__secondary {
  overflow: hidden;
  color: var(--muted, #6b7280);
  font-size: 11px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.compose-schedule-menu__separator {
  height: 1px;
  margin: 4px 6px;
  background: var(--border, #d6d9e2);
}
.compose-schedule-menu__description {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}
.base.app-button.compose-send:disabled {
  background: var(--colour-neutral-border, var(--border, #d6d9e2));
  color: var(--colour-ti-secondary, var(--muted, #6b7280));
  cursor: not-allowed;
  opacity: 1;
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
