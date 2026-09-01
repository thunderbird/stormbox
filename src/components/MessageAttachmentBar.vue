<script setup lang="ts">
import {
  Download,
  Eye,
  LoaderCircle,
  Paperclip,
  RefreshCw,
} from '@lucide/vue';

import type { MessageAttachmentRow } from '../composables/useMessageAttachments';
import {
  formatAttachmentSize,
  sanitizeAttachmentFilename,
} from '../utils/attachment-presentation';
import AppIconButton from './AppIconButton.vue';

defineProps<{
  rows: MessageAttachmentRow[];
}>();

const emit = defineEmits<{
  preview: [key: string];
  download: [key: string];
  retry: [key: string];
}>();

function filename(row: MessageAttachmentRow): string {
  return row.part.name
    ? sanitizeAttachmentFilename(row.part.name)
    : '(unnamed attachment)';
}

function metadata(row: MessageAttachmentRow): string {
  const type = row.part.mime_type || 'Unknown type';
  if (row.part.size == null) return type;
  const bytes = Number(row.part.size);
  if (!Number.isFinite(bytes) || bytes < 0) return type;
  return `${type} · ${formatAttachmentSize(bytes)}`;
}

function pendingLabel(row: MessageAttachmentRow): string {
  if (!row.pending) return '';
  const loaded = Number(row.progress?.loaded ?? 0);
  const total = Number(row.progress?.total ?? 0);
  const percent = row.progress?.phase === 'complete'
    ? 100
    : total > 0
      ? Math.min(100, Math.round((loaded / total) * 100))
      : null;
  const progress = percent == null ? '' : ` ${percent}%`;
  if (row.progress?.phase === 'complete') {
    const completedAction = row.pending === 'download'
      ? 'Download complete'
      : row.previewKind === 'pdf-browser'
        ? 'PDF ready'
        : 'Preview ready';
    return `${completedAction}${progress}`;
  }
  const action = row.pending === 'download'
    ? 'Downloading'
    : row.previewKind === 'pdf-browser'
      ? 'Opening'
      : 'Preparing preview';
  return `${action}${progress}`;
}

function previewLabel(row: MessageAttachmentRow): string {
  if (row.previewKind === 'pdf-browser') return `Open ${filename(row)}`;
  return `${row.showPreview ? 'Hide preview of' : 'Preview'} ${filename(row)}`;
}

function pdfViewerHref(row: MessageAttachmentRow): string {
  return `/pdf-viewer.html#${encodeURIComponent(row.pdfViewerToken)}`;
}

function openPdf(event: MouseEvent, row: MessageAttachmentRow): void {
  if (row.pending != null || !row.part.blob_id) {
    event.preventDefault();
    return;
  }
  emit('preview', row.key);
}

function retryLabel(row: MessageAttachmentRow): string {
  const action = row.failedAction === 'download'
    ? 'download'
    : row.previewKind === 'pdf-browser'
      ? 'open'
      : 'preview';
  return `Retry ${action} for ${filename(row)}`;
}
</script>

<template>
  <section
    v-if="rows.length"
    class="message-attachment-bar"
    aria-label="Attachments"
  >
    <h3>Attachments <span aria-hidden="true">({{ rows.length }})</span></h3>
    <ul class="message-attachment-bar__list">
      <li v-for="row in rows" :key="row.key" class="message-attachment-row">
        <Paperclip
          :size="15"
          :stroke-width="1.75"
          class="message-attachment-row__icon"
          aria-hidden="true"
        />
        <div class="message-attachment-row__description">
          <span class="message-attachment-row__name" :title="filename(row)">
            {{ filename(row) }}
          </span>
          <span class="message-attachment-row__metadata">{{ metadata(row) }}</span>
          <span
            v-show="row.pending"
            class="message-attachment-row__status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {{ pendingLabel(row) }}
          </span>
          <span
            v-if="row.error"
            class="message-attachment-row__error"
            role="alert"
          >
            {{ row.error }}
          </span>
          <span
            v-else-if="row.rasterUnavailable"
            class="message-attachment-row__status"
          >
            Preview unavailable
          </span>
        </div>
        <div class="message-attachment-row__actions">
          <a
            v-if="row.previewKind === 'pdf-browser'"
            class="message-attachment-row__pdf-link"
            :class="{ 'message-attachment-row__pdf-link--disabled': row.pending !== null || !row.part.blob_id }"
            :href="pdfViewerHref(row)"
            target="_blank"
            rel="noopener noreferrer"
            :aria-disabled="row.pending !== null || !row.part.blob_id"
            :tabindex="row.pending !== null || !row.part.blob_id ? -1 : undefined"
            :title="previewLabel(row)"
            :aria-label="previewLabel(row)"
            @click="openPdf($event, row)"
          >
            <LoaderCircle
              v-if="row.pending === 'preview'"
              class="message-attachment-row__spinner"
              :size="16"
              :stroke-width="1.75"
            />
            <Eye v-else :size="16" :stroke-width="1.75" />
          </a>
          <AppIconButton
            v-else-if="row.previewKind !== 'download-only' && !row.rasterUnavailable"
            :disabled="row.pending !== null"
            :title="previewLabel(row)"
            :aria-label="previewLabel(row)"
            @click="emit('preview', row.key)"
          >
            <LoaderCircle
              v-if="row.pending === 'preview'"
              class="message-attachment-row__spinner"
              :size="16"
              :stroke-width="1.75"
            />
            <Eye v-else :size="16" :stroke-width="1.75" />
          </AppIconButton>
          <AppIconButton
            :disabled="row.pending !== null || !row.part.blob_id"
            :title="`Download ${filename(row)}`"
            :aria-label="`Download ${filename(row)}`"
            @click="emit('download', row.key)"
          >
            <LoaderCircle
              v-if="row.pending === 'download'"
              class="message-attachment-row__spinner"
              :size="16"
              :stroke-width="1.75"
            />
            <Download v-else :size="16" :stroke-width="1.75" />
          </AppIconButton>
          <AppIconButton
            v-if="row.failedAction"
            :disabled="row.pending !== null"
            :title="retryLabel(row)"
            :aria-label="retryLabel(row)"
            @click="emit('retry', row.key)"
          >
            <RefreshCw :size="16" :stroke-width="1.75" />
          </AppIconButton>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.message-attachment-bar {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  min-width: 0;
  max-height: min(40vh, 220px);
  overflow: hidden;
  border-top: 1px solid var(--border-soft);
  background: color-mix(in srgb, var(--panel) 96%, var(--panel2));
}

.message-attachment-bar h3 {
  flex: 0 0 auto;
  margin: 0;
  padding: 9px var(--message-content-trailing-inset) 5px var(--message-content-inset);
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}

.message-attachment-bar__list {
  min-height: 0;
  margin: 0;
  padding: 0 8px 8px;
  overflow-y: auto;
  list-style: none;
}

.message-attachment-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  min-width: 0;
  padding: 5px 8px;
  border-radius: 6px;
}

.message-attachment-row:hover {
  background: var(--rowHover);
}

.message-attachment-row__icon {
  color: var(--muted);
}

.message-attachment-row__pdf-link {
  display: inline-grid;
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  place-items: center;
  border-radius: 8px;
  color: var(--muted);
  text-decoration: none;
}

.message-attachment-row__pdf-link:hover {
  background: var(--rowHover);
  color: var(--text);
}

.message-attachment-row__pdf-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.message-attachment-row__pdf-link--disabled,
.message-attachment-row__pdf-link--disabled:hover {
  background: transparent;
  color: var(--muted);
  opacity: 0.35;
  pointer-events: none;
}

.message-attachment-row__description {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  min-width: 0;
}

.message-attachment-row__name {
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-attachment-row__metadata,
.message-attachment-row__status,
.message-attachment-row__error {
  color: var(--muted);
  font-size: 12px;
}

.message-attachment-row__status,
.message-attachment-row__error {
  flex-basis: 100%;
}

.message-attachment-row__error {
  color: #d95757;
}

.message-attachment-row__actions {
  display: flex;
  align-items: center;
}

.message-attachment-row__actions :deep(.app-icon-button) {
  width: 30px;
  height: 30px;
  flex-basis: 30px;
}

.message-attachment-row__spinner {
  animation: message-attachment-spin 0.9s linear infinite;
}

@keyframes message-attachment-spin {
  to { transform: rotate(360deg); }
}
</style>
