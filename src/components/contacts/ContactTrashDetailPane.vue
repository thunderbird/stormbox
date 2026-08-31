<script setup lang="ts">
import { ArrowLeft, RotateCcw, Trash2 } from '@lucide/vue';
import { computed, nextTick, ref } from 'vue';

import type { ContactTrashDetail } from '../../types';
import { contactDetailFromTrash } from '../../utils/contact-trash-display';
import AppButton from '../AppButton.vue';
import AppIconButton from '../AppIconButton.vue';
import ContactDetailsView from './ContactDetailsView.vue';

const props = withDefaults(defineProps<{
  addressbookNames?: string[];
  busy?: boolean;
  detail: ContactTrashDetail | null;
  error?: string | null;
  loading?: boolean;
}>(), {
  addressbookNames: () => [],
});

const emit = defineEmits<{
  back: [];
  deleteForever: [];
  restore: [];
  retry: [];
}>();

const paneEl = ref<HTMLElement | null>(null);
const expiresLabel = computed(() =>
  props.detail
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
      .format(new Date(props.detail.expires_at))
    : '');
const contactDetail = computed(() =>
  props.detail ? contactDetailFromTrash(props.detail) : null);

async function focusDetail(): Promise<void> {
  await nextTick();
  paneEl.value?.focus();
}

defineExpose({ focusDetail });
</script>

<template>
  <article
    ref="paneEl"
    class="trash-detail"
    tabindex="-1"
    aria-label="Trashed contact details"
  >
    <header class="trash-detail__header">
      <AppIconButton title="Back" aria-label="Back" @click="emit('back')">
        <ArrowLeft :size="18" :stroke-width="1.65" aria-hidden="true" />
      </AppIconButton>
      <div class="trash-detail__actions">
        <AppButton
          :disabled="busy || loading || !detail"
          @click="emit('restore')"
        >
          <template #iconLeft>
            <RotateCcw :size="16" :stroke-width="1.9" aria-hidden="true" />
          </template>
          Restore
        </AppButton>
        <AppButton
          class="trash-detail__delete"
          variant="outline"
          :disabled="busy || loading || !detail"
          @click="emit('deleteForever')"
        >
          <template #iconLeft>
            <Trash2 :size="16" :stroke-width="1.9" aria-hidden="true" />
          </template>
          Delete Forever
        </AppButton>
      </div>
    </header>
    <div
      v-if="loading"
      class="trash-detail__content trash-detail__loading"
      role="status"
    >
      Loading trashed contact…
    </div>
    <div
      v-else-if="error"
      class="trash-detail__content trash-detail__error"
      role="alert"
    >
      <p>{{ error }}</p>
      <AppButton variant="outline" @click="emit('retry')">
        Try again
      </AppButton>
    </div>
    <ContactDetailsView
      v-else-if="detail && contactDetail"
      :addressbook-names="addressbookNames"
      :detail="contactDetail"
      :expiry-label="expiresLabel"
    />
  </article>
</template>

<style scoped>
.trash-detail {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  outline: none;
}

.trash-detail__header {
  display: flex;
  min-height: 57px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 12px;
  border-bottom: 1px solid var(--border, #e3e6ee);
}

.trash-detail__actions {
  display: flex;
  gap: 8px;
}

.trash-detail__delete {
  color: var(--danger, #c93838);
}

.trash-detail__content {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 32px;
}

.trash-detail__content p {
  margin: 0 0 8px;
}

.trash-detail__loading {
  color: var(--muted, #6b7388);
}

.trash-detail__error p {
  margin-bottom: 16px;
}

@media (max-width: 639px) {
  .trash-detail__header {
    align-items: flex-start;
  }

  .trash-detail__actions {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .trash-detail__content {
    padding: 24px 20px;
  }
}
</style>
