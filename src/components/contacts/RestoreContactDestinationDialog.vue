<script setup lang="ts">
import { ref } from 'vue';

import { useModalFocus } from '../../composables/useModalFocus';
import type { AddressbookRow } from '../../types';
import AppButton from '../AppButton.vue';
import { addressBookDisplayName } from './directory-types';

defineProps<{
  addressbooks: AddressbookRow[];
  busy?: boolean;
  count: number;
}>();

const emit = defineEmits<{
  cancel: [];
  choose: [addressbookId: number];
}>();

const dialogEl = ref<HTMLElement | null>(null);
useModalFocus(dialogEl, { containTab: true });
</script>

<template>
  <div class="restore-destination" role="presentation" @click.self="emit('cancel')">
    <section
      ref="dialogEl"
      class="restore-destination__panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="restore-destination-title"
      tabindex="-1"
      @keydown.esc.prevent="emit('cancel')"
    >
      <h2 id="restore-destination-title">Choose an address book</h2>
      <p>
        {{ count === 1 ? 'This contact has' : 'These contacts have' }}
        no original writable address book. Choose where to restore
        {{ count === 1 ? 'it' : 'them' }}.
      </p>
      <div class="restore-destination__books">
        <button
          v-for="book in addressbooks"
          :key="book.id"
          type="button"
          :disabled="busy"
          @click="emit('choose', book.id)"
        >
          {{ addressBookDisplayName(book) }}
        </button>
      </div>
      <div class="restore-destination__actions">
        <AppButton variant="outline" :disabled="busy" @click="emit('cancel')">
          Cancel
        </AppButton>
      </div>
    </section>
  </div>
</template>

<style scoped>
.restore-destination {
  position: fixed;
  z-index: 90;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: color-mix(in srgb, #0d162a 48%, transparent);
}

.restore-destination__panel {
  width: min(440px, 100%);
  padding: 20px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 12px;
  background: var(--surface, #fff);
}

.restore-destination__panel h2 {
  margin: 0 0 8px;
}

.restore-destination__panel p {
  color: var(--muted, #6b7388);
}

.restore-destination__books {
  display: grid;
  gap: 6px;
  max-height: 240px;
  overflow-y: auto;
  margin-top: 16px;
}

.restore-destination__books button {
  padding: 9px 10px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 7px;
  background: transparent;
  color: var(--text, #1a1d24);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.restore-destination__books button:hover,
.restore-destination__books button:focus-visible {
  border-color: var(--accent);
  background: var(--rowHover, #f0f1f6);
  outline: none;
}

.restore-destination__actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 18px;
}
</style>
