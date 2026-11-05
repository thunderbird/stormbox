<script setup lang="ts">
import { t } from '../../i18n/messages';
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
useModalFocus(dialogEl, { containTab: true, onDefault: chooseDefault });

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
      return t('contactsConfirmationDialog.saveYourChanges');
    case 'external-change':
      return t('contactsConfirmationDialog.contactChangedElsewhere');
    case 'external-addressbook-change':
      return t('contactsConfirmationDialog.addressBookChangedElsewhere');
    case 'delete-contacts-scoped':
      return t('contactsConfirmationDialog.deleteThisContactFromPlural', { arg1: props.scopeLabel || t('contactsConfirmationDialog.thisAddressBook'), arg2: count, arg3: props.scopeLabel || t('contactsConfirmationDialog.thisAddressBook') }, count);
    case 'delete-identity':
      return t('contactsConfirmationDialog.deleteThisIdentity');
    case 'delete-contact-trash':
      return t('contactsConfirmationDialog.deleteThisContactForeverPlural', { arg1: count }, count);
    default: {
      const exhaustive: never = props.kind;
      return exhaustive;
    }
  }
});

const description = computed(() => {
  const count = Math.max(1, props.count);
  const contacts = t('contactsConfirmationDialog.thisContactPlural', { arg1: count }, count);
  switch (props.kind) {
    case 'unsaved':
      return t('contactsConfirmationDialog.saveBeforeContinuingDiscardYourEditsOrCancelTo');
    case 'external-change':
      return t('contactsConfirmationDialog.thisEntryMovedOrWasRemovedWhileYouWere');
    case 'external-addressbook-change':
      return t('contactsConfirmationDialog.thisAddressBookWasRemovedWhileYouWereEditing');
    case 'delete-contacts-scoped': {
      const scope = props.scopeLabel || t('contactsConfirmationDialog.thisAddressBook');
      let knownConsequence = t('contactsConfirmationDialog.basedOnTheCurrentContactDataNoneWillMove');
      if (props.permanentCount === 1 && count === 1) {
        knownConsequence = t('contactsConfirmationDialog.thisIsCurrentlyTheContactSOnlyAddressBook');
      } else if (props.permanentCount > 0) {
        knownConsequence = t('contactsConfirmationDialog.selectedContactCurrentlyNoOtherAddressBookMembershipAndPlural', { arg1: props.permanentCount, arg2: props.permanentCount }, props.permanentCount);
      }
      return t('contactsConfirmationDialog.willBeRemovedFromAnyContactWhoseFinalMembership', { value1: contacts, value2: scope, value3: knownConsequence });
    }
    case 'delete-contact-trash':
      return t('contactsConfirmationDialog.willBeRemovedFromTrashImmediatelyThisActionCannot', { value1: contacts });
    case 'delete-identity':
      return t('contactsConfirmationDialog.willBeRemoved', { value1: props.subject || t('contactsConfirmationDialog.thisIdentity') });
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
  props.kind === 'delete-contact-trash' ? t('contactsConfirmationDialog.deleteForever') : t('contactsConfirmationDialog.delete'));

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (props.busy) return;
    emit('choose', 'cancel');
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
          {{ t('contactsConfirmationDialog.cancel') }}
        </AppButton>
        <AppButton
          v-if="showsSaveChoices"
          class="contacts-confirm__danger"
          variant="outline"
          :disabled="busy"
          @click="emit('choose', 'discard')"
        >
          {{ t('contactsConfirmationDialog.discard') }}
        </AppButton>
        <AppButton
          v-if="showsSaveChoices"
          :disabled="busy"
          @click="emit('choose', 'save')"
        >
          {{ busy ? t('contactsConfirmationDialog.saving') : t('contactsConfirmationDialog.save') }}
        </AppButton>
        <AppButton
          v-else
          class="contacts-confirm__danger"
          :disabled="busy"
          @click="emit('choose', 'delete')"
        >
          {{ busy ? t('contactsConfirmationDialog.deleting') : deleteLabel }}
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
  background: var(--modal-scrim);
  backdrop-filter: var(--modal-scrim-blur);
}

.contacts-confirm__panel {
  width: min(440px, 100%);
  padding: 20px;
  border: 1px solid var(--modal-border);
  border-radius: 12px;
  background: var(--modal-surface);
  box-shadow: var(--modal-shadow);
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
