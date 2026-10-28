<script setup lang="ts">
import { t, formatNumber } from '../../i18n/messages';
import { computed, ref } from 'vue';

import { useModalFocus } from '../../composables/useModalFocus';
import type {
  AddressBookInventory,
  AddressbookRow,
} from '../../types';
import AppButton from '../AppButton.vue';
import LocalizedText from '../LocalizedText.vue';
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
useModalFocus(dialogEl, { containTab: true, onDefault: cancel });

const title = computed(() =>
  props.stale ? t('addressBookDeleteDialog.addressBookContentsChanged') : t('addressBookDeleteDialog.deleteAddressBook'));

function cancel(): void {
  if (!props.busy) emit('cancel');
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
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
        {{ t('addressBookDeleteDialog.theAddressBookChangedAfterYourFirstReviewReview') }}
      </p>
      <p id="address-book-delete-description">
        {{ t('addressBookDeleteDialog.willBeDeleted', { value1: addressBookDisplayName(addressbook) }) }}
      </p>
      <ul id="address-book-delete-effects">
        <LocalizedText tag="li" keypath="addressBookDeleteDialog.exclusiveEffect" :plural="inventory.exclusiveCount">
          <template #count><strong>{{ formatNumber(inventory.exclusiveCount) }}</strong></template>
        </LocalizedText>
        <LocalizedText tag="li" keypath="addressBookDeleteDialog.sharedEffect" :plural="inventory.sharedCount">
          <template #count><strong>{{ formatNumber(inventory.sharedCount) }}</strong></template>
        </LocalizedText>
        <LocalizedText tag="li" keypath="addressBookDeleteDialog.mediaEffect" :plural="inventory.mediaBearingCount">
          <template #count><strong>{{ formatNumber(inventory.mediaBearingCount) }}</strong></template>
        </LocalizedText>
      </ul>
      <p v-if="addressbook.is_default === 1" class="address-book-delete__default-note">
        {{ t('addressBookDeleteDialog.thisIsTheDefaultAddressBookTheServerWill') }}
      </p>
      <div class="address-book-delete__actions">
        <AppButton variant="outline" :disabled="busy" @click="cancel">
          {{ t('addressBookDeleteDialog.cancel') }}
        </AppButton>
        <AppButton
          class="address-book-delete__danger"
          :disabled="busy"
          @click="emit('confirm')"
        >
          {{
            busy
              ? t('addressBookDeleteDialog.deleting')
              : (stale ? t('addressBookDeleteDialog.confirmDelete') : t('addressBookDeleteDialog.deleteAddressBook2'))
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
  background: var(--modal-scrim);
  backdrop-filter: var(--modal-scrim-blur);
}

.address-book-delete__panel {
  width: min(500px, 100%);
  padding: 20px;
  border: 1px solid var(--modal-border);
  border-radius: 12px;
  background: var(--modal-surface);
  box-shadow: var(--modal-shadow);
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
