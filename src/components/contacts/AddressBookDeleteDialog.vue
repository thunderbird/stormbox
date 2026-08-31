<script setup lang="ts">
import { computed, ref } from 'vue';

import { useModalFocus } from '../../composables/useModalFocus';
import type {
  AddressBookInventory,
  AddressbookRow,
} from '../../types';
import AppButton from '../AppButton.vue';
import { addressBookDisplayName } from './directory-types';

const props = withDefaults(defineProps<{
  addressbook: AddressbookRow;
  busy?: boolean;
  inventory: AddressBookInventory;
  stale?: boolean;
}>(), {
  busy: false,
  stale: false,
});

const emit = defineEmits<{
  cancel: [];
  confirm: [];
}>();

const dialogEl = ref<HTMLElement | null>(null);
useModalFocus(dialogEl, { onDefault: cancel });

const title = computed(() =>
  props.stale ? 'Address book contents changed' : 'Delete address book?');

function cancel(): void {
  if (!props.busy) emit('cancel');
}

function focusableElements(): HTMLElement[] {
  if (!dialogEl.value) return [];
  return [...dialogEl.value.querySelectorAll<HTMLElement>(
    'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
  )];
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
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
</script>

<template>
  <div class="address-book-delete" role="presentation" @click.self="cancel">
    <section
      ref="dialogEl"
      class="address-book-delete__panel"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="address-book-delete-title"
      aria-describedby="address-book-delete-description address-book-delete-effects"
      tabindex="-1"
      @keydown.capture="onKeydown"
    >
      <h2 id="address-book-delete-title">{{ title }}</h2>
      <p
        v-if="stale"
        class="address-book-delete__stale"
        role="status"
      >
        The address book changed after your first review. Review these updated
        counts and confirm again.
      </p>
      <p id="address-book-delete-description">
        “{{ addressBookDisplayName(addressbook) }}” will be deleted.
      </p>
      <ul id="address-book-delete-effects">
        <li>
          <strong>{{ inventory.exclusiveCount }}</strong>
          {{ inventory.exclusiveCount === 1 ? 'contact belongs' : 'contacts belong' }}
          only to this address book and will be permanently destroyed.
        </li>
        <li>
          <strong>{{ inventory.sharedCount }}</strong>
          {{ inventory.sharedCount === 1 ? 'contact has' : 'contacts have' }}
          other address-book memberships. Only
          {{ inventory.sharedCount === 1 ? 'its membership' : 'their memberships' }}
          in this address book will be removed.
        </li>
        <li>
          <strong>{{ inventory.mediaBearingCount }}</strong>
          {{ inventory.mediaBearingCount === 1 ? 'contact includes' : 'contacts include' }}
          photos or other media.
        </li>
      </ul>
      <p v-if="addressbook.is_default === 1" class="address-book-delete__default-note">
        This is the default address book. The server will choose a replacement default.
      </p>
      <div class="address-book-delete__actions">
        <AppButton variant="outline" :disabled="busy" @click="cancel">
          Cancel
        </AppButton>
        <AppButton
          class="address-book-delete__danger"
          :disabled="busy"
          @click="emit('confirm')"
        >
          {{
            busy
              ? 'Deleting…'
              : (stale ? 'Confirm delete' : 'Delete address book')
          }}
        </AppButton>
      </div>
    </section>
  </div>
</template>

<style scoped>
.address-book-delete {
  position: fixed;
  z-index: 90;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: color-mix(in srgb, #0d162a 48%, transparent);
}

.address-book-delete__panel {
  width: min(500px, 100%);
  padding: 20px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 12px;
  background: var(--surface, #fff);
  box-shadow: 0 20px 54px color-mix(in srgb, #000 35%, transparent);
}

.address-book-delete__panel h2 {
  margin: 0 0 8px;
  font-size: 18px;
}

.address-book-delete__panel p,
.address-book-delete__panel ul {
  color: var(--muted, #6b7388);
  line-height: 1.45;
}

.address-book-delete__panel p {
  margin: 0;
}

.address-book-delete__panel ul {
  display: grid;
  gap: 7px;
  margin: 14px 0;
  padding-left: 22px;
}

.address-book-delete__stale {
  margin-bottom: 12px !important;
  padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--text, #1a1d24) !important;
}

.address-book-delete__default-note {
  font-weight: 600;
}

.address-book-delete__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}

.address-book-delete__danger {
  color: #c93838;
}
</style>
