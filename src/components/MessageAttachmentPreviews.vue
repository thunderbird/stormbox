<script setup lang="ts">
import { X } from '@lucide/vue';

import type { MessageAttachmentRow } from '../composables/useMessageAttachments';
import { sanitizeAttachmentFilename } from '../utils/attachment-presentation';
import AppIconButton from './AppIconButton.vue';

defineProps<{
  rows: MessageAttachmentRow[];
}>();

const emit = defineEmits<{
  preview: [key: string];
}>();

function filename(row: MessageAttachmentRow): string {
  return row.part.name
    ? sanitizeAttachmentFilename(row.part.name)
    : '(unnamed attachment)';
}
</script>

<template>
  <section
    v-if="rows.some((row) => row.showPreview && (row.previewUrl || row.textPreview))"
    class="message-attachment-previews"
    aria-label="Attachment previews"
  >
    <template v-for="row in rows" :key="row.key">
      <figure
        v-if="row.showPreview && row.previewUrl"
        class="message-attachment-preview message-attachment-preview--raster"
      >
        <figcaption class="message-attachment-preview__header">
          <span>{{ filename(row) }}</span>
          <AppIconButton
            :title="`Hide preview of ${filename(row)}`"
            :aria-label="`Hide preview of ${filename(row)}`"
            @click="emit('preview', row.key)"
          >
            <X :size="16" :stroke-width="1.75" />
          </AppIconButton>
        </figcaption>
        <img :src="row.previewUrl" :alt="filename(row)">
      </figure>
      <section
        v-else-if="row.showPreview && row.textPreview"
        class="message-attachment-preview message-attachment-preview--text"
        :aria-label="`Preview of ${filename(row)}`"
      >
        <div class="message-attachment-preview__header">
          <h3>{{ filename(row) }}</h3>
          <AppIconButton
            :title="`Hide preview of ${filename(row)}`"
            :aria-label="`Hide preview of ${filename(row)}`"
            @click="emit('preview', row.key)"
          >
            <X :size="16" :stroke-width="1.75" />
          </AppIconButton>
        </div>
        <pre>{{ row.textPreview.text }}</pre>
        <p v-if="row.textPreview.truncated" class="message-attachment-preview__notice">
          Preview truncated at 256 KiB.
        </p>
      </section>
    </template>
  </section>
</template>

<style scoped>
.message-attachment-previews {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  padding: 8px var(--message-content-trailing-inset) 18px var(--message-content-inset);
}

.message-attachment-preview {
  min-width: 0;
  margin: 0;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel) 94%, var(--panel2));
  overflow: hidden;
}

.message-attachment-preview__header {
  display: flex;
  min-height: 38px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 4px 2px 12px;
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
}

.message-attachment-preview__header h3,
.message-attachment-preview__header span {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.message-attachment-preview--raster img {
  display: block;
  width: auto;
  max-width: 100%;
  height: auto;
  margin: 0 auto;
}

.message-attachment-preview--text pre {
  max-height: 320px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  border-top: 1px solid var(--border-soft);
  color: var(--text);
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.message-attachment-preview__notice {
  margin: 0;
  padding: 6px 12px;
  border-top: 1px solid var(--border-soft);
  color: var(--muted);
  font-size: 12px;
}
</style>
