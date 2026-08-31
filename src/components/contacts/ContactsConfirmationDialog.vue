<script setup lang="ts">
import {
  computed,
  ref,
} from 'vue';

import { useModalFocus } from '../../composables/useModalFocus';
import AppButton from '../AppButton.vue';
import type {
  ContactsConfirmationChoice,
  ContactsConfirmationKind,
} from './directory-types';

const props = withDefaults(defineProps<{
  busy?: boolean;
  count?: number;
  kind: ContactsConfirmationKind;
  permanentCount?: number;
  scopeLabel?: string;
  subject?: string;
}>(), {
  busy: false,
  count: 1,
  permanentCount: 0,
  scopeLabel: '',
  subject: '',
});

const emit = defineEmits<{
  choose: [choice: ContactsConfirmationChoice];
}>();

const dialogEl = ref<HTMLElement | null>(null);
useModalFocus(dialogEl, { onDefault: chooseDefault });

function defaultChoice(): ContactsConfirmationChoice {
  switch (props.kind) {
    case 'unsaved':
    case 'external-addressbook-change':
    case 'external-change':
      return 'save';
    case 'delete-contacts-scoped':
    case 'delete-contact-trash':
    case 'delete-identity':
      return 'cancel';
    default: {
      const exhaustive: never = props.kind;
      return exhaustive;
    }
  }
}

function chooseDefault(): void {
  if (!props.busy) emit('choose', defaultChoice());
}

const title = computed(() => {
  const count = Math.max(1, props.count);
  switch (props.kind) {
    case 'unsaved':
      return 'Save your changes?';
    case 'external-change':
      return 'Contact changed elsewhere';
    case 'external-addressbook-change':
      return 'Address book changed elsewhere';
    case 'delete-contacts-scoped':
      return count === 1
        ? `Delete this contact from ${props.scopeLabel || 'this address book'}?`
        : `Delete ${count} contacts from ${props.scopeLabel || 'this address book'}?`;
    case 'delete-identity':
      return 'Delete this identity?';
    case 'delete-contact-trash':
      return count === 1
        ? 'Delete this contact forever?'
        : `Delete ${count} contacts forever?`;
    default: {
      const exhaustive: never = props.kind;
      return exhaustive;
    }
  }
});

const description = computed(() => {
  const count = Math.max(1, props.count);
  const contacts = count === 1 ? 'This contact' : `These ${count} contacts`;
  switch (props.kind) {
    case 'unsaved':
      return 'Save before continuing, discard your edits, or cancel to keep editing.';
    case 'external-change':
      return 'This entry moved or was removed while you were editing. Save to try your draft, discard it, or cancel to keep editing.';
    case 'external-addressbook-change':
      return 'This address book was removed while you were editing. Save to try your draft, discard it, or cancel to keep editing.';
    case 'delete-contacts-scoped': {
      const scope = props.scopeLabel || 'this address book';
      let knownConsequence = 'Based on the current contact data, none will move to Trash.';
      if (props.permanentCount === 1 && count === 1) {
        knownConsequence = 'This is currently the contact’s only address-book membership, so it will move to Trash and remain recoverable for 30 days.';
      } else if (props.permanentCount > 0) {
        knownConsequence = `${props.permanentCount} selected contact${
          props.permanentCount === 1 ? '' : 's'
        } currently ${
          props.permanentCount === 1 ? 'has' : 'have'
        } no other address-book membership and will move to Trash for 30 days.`;
      }
      return `${contacts} will be removed from ${scope}. Any contact whose final membership is removed will move to Trash. ${knownConsequence}`;
    }
    case 'delete-contact-trash':
      return `${contacts} will be removed from Trash immediately. This action cannot be undone.`;
    case 'delete-identity':
      return `“${props.subject || 'This identity'}” will be removed.`;
    default: {
      const exhaustive: never = props.kind;
      return exhaustive;
    }
  }
});
const showsSaveChoices = computed(() =>
  props.kind === 'unsaved'
  || props.kind === 'external-change'
  || props.kind === 'external-addressbook-change');
const deleteLabel = computed(() =>
  props.kind === 'delete-contact-trash' ? 'Delete forever' : 'Delete');

function focusableElements(): HTMLElement[] {
  if (!dialogEl.value) return [];
  return [...dialogEl.value.querySelectorAll<HTMLElement>(
    'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
  )];
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (props.busy) return;
    emit('choose', 'cancel');
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = focusableElements();
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (document.activeElement === dialogEl.value) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  } else if (!dialogEl.value?.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

function cancelFromBackdrop(): void {
  if (!props.busy) emit('choose', 'cancel');
}
</script>

<template>
  <div
    class="contacts-confirm"
    role="presentation"
    @click.self="cancelFromBackdrop"
  >
    <section
      ref="dialogEl"
      class="contacts-confirm__panel"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="contacts-confirm-title"
      aria-describedby="contacts-confirm-description"
      tabindex="-1"
      @keydown.capture="onKeydown"
    >
      <h2 id="contacts-confirm-title">{{ title }}</h2>
      <p id="contacts-confirm-description">{{ description }}</p>
      <div class="contacts-confirm__actions">
        <AppButton
          variant="outline"
          :disabled="busy"
          @click="emit('choose', 'cancel')"
        >
          Cancel
        </AppButton>
        <AppButton
          v-if="showsSaveChoices"
          class="contacts-confirm__danger"
          variant="outline"
          :disabled="busy"
          @click="emit('choose', 'discard')"
        >
          Discard
        </AppButton>
        <AppButton
          v-if="showsSaveChoices"
          :disabled="busy"
          @click="emit('choose', 'save')"
        >
          {{ busy ? 'Saving…' : 'Save' }}
        </AppButton>
        <AppButton
          v-else
          class="contacts-confirm__danger"
          :disabled="busy"
          @click="emit('choose', 'delete')"
        >
          {{ busy ? 'Deleting…' : deleteLabel }}
        </AppButton>
      </div>
    </section>
  </div>
</template>

<style scoped>
.contacts-confirm {
  position: fixed;
  z-index: 90;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: color-mix(in srgb, #0d162a 48%, transparent);
}

.contacts-confirm__panel {
  width: min(440px, 100%);
  padding: 20px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 12px;
  background: var(--surface, #fff);
  box-shadow: 0 20px 54px color-mix(in srgb, #000 35%, transparent);
}

.contacts-confirm__panel h2 {
  margin: 0 0 8px;
  font-size: 18px;
}

.contacts-confirm__panel p {
  margin: 0;
  color: var(--muted, #6b7388);
  line-height: 1.45;
}

.contacts-confirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}

.contacts-confirm__danger {
  color: #c93838;
}
</style>
