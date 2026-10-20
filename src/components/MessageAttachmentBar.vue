<script setup lang="ts">
import { computed, ref, shallowRef, useId, watch } from 'vue';
import { useElementSize, useResizeObserver } from '@vueuse/core';
import {
  ChevronDown,
  ChevronUp,
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

const props = defineProps<{
  contextKey?: string | number | null;
  rows: MessageAttachmentRow[];
}>();

const listId = `attachment-list-${useId()}`;
const barEl = ref<HTMLElement | null>(null);
const headingEl = ref<HTMLElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
const firstRowEl = ref<HTMLElement | null>(null);
const toggleEl = ref<HTMLButtonElement | null>(null);
const rowElements = shallowRef<HTMLElement[]>([]);
const expanded = ref(true);
const hasOverflow = ref(false);
const { height: headingHeight } = useElementSize(headingEl, undefined, { box: 'border-box' });
const { height: firstRowHeight } = useElementSize(firstRowEl, undefined, { box: 'border-box' });

watch([
  () => props.contextKey,
  () => JSON.stringify(props.rows.map(row => row.key)),
  listEl,
], () => {
  rowElements.value = Array.from(listEl.value?.children ?? []) as HTMLElement[];
  firstRowEl.value = rowElements.value[0] ?? null;
  expanded.value = true;
  if (listEl.value) listEl.value.scrollTop = 0;
  updateOverflow();
}, { flush: 'post' });

const resizeTargets = computed(() => [
  barEl.value?.parentElement,
  listEl.value,
  ...rowElements.value,
]);
useResizeObserver(resizeTargets, updateOverflow, { box: 'border-box' });
watch([headingHeight, firstRowHeight], updateOverflow, { flush: 'post' });

function updateOverflow(): void {
  const bar = barEl.value;
  const list = listEl.value;
  if (!bar || !list) return;
  const styles = getComputedStyle(bar);
  const listBudget = Number.parseFloat(styles.maxHeight)
    - headingHeight.value - Number.parseFloat(styles.borderTopWidth || '0');
  hasOverflow.value = props.rows.length > 1 && list.scrollHeight > listBudget + 1;
  if (hasOverflow.value) return;
  expanded.value = true;
  if (document.activeElement === toggleEl.value) {
    const target = firstRowEl.value?.querySelector<HTMLElement>('button:not(:disabled), a:not([aria-disabled="true"])')
      ?? bar;
    target.focus({ preventScroll: true });
  }
}

function toggleExpanded(): void {
  toggleEl.value?.focus({ preventScroll: true });
  expanded.value = !expanded.value;
  if (listEl.value) listEl.value.scrollTop = 0;
}

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
    ref="barEl"
    class="message-attachment-bar"
    :class="{ 'message-attachment-bar--collapsed': !expanded }"
    :style="{
      '--attachment-heading-height': `${headingHeight}px`,
      '--attachment-first-row-height': `${firstRowHeight}px`,
    }"
    aria-label="Attachments"
    tabindex="-1"
  >
    <div ref="headingEl" class="message-attachment-bar__heading">
      <h3>Attachments <span aria-hidden="true">({{ rows.length }})</span></h3>
      <button
        v-show="hasOverflow"
        ref="toggleEl"
        class="message-attachment-bar__toggle"
        type="button"
        :aria-expanded="expanded"
        :aria-controls="listId"
        :aria-label="`${expanded ? 'Collapse' : 'Expand'} attachment list`"
        @click="toggleExpanded"
      >
        <ChevronUp v-if="expanded" :size="14" :stroke-width="1.75" aria-hidden="true" />
        <ChevronDown v-else :size="14" :stroke-width="1.75" aria-hidden="true" />
        {{ expanded ? 'Collapse' : 'Expand' }}
      </button>
    </div>
    <ul :id="listId" ref="listEl" class="message-attachment-bar__list">
      <li
        v-for="(row, index) in rows"
        :key="row.key"
        class="message-attachment-row"
        :class="{ 'message-attachment-row--collapsed': !expanded && index > 0 }"
        :inert="!expanded && index > 0"
        :aria-hidden="!expanded && index > 0 ? true : undefined"
      >
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
  --attachment-list-padding: 8px;
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  min-width: 0;
  max-height: max(
    calc(var(--message-view-height, var(--app-viewport-height)) * 0.2),
    calc(var(--attachment-heading-height) + var(--attachment-first-row-height) + var(--attachment-list-padding) + 1px)
  );
  overflow: hidden;
  border-top: 1px solid var(--border-soft);
  background: color-mix(in srgb, var(--panel) 96%, var(--panel2));
}

.message-attachment-bar:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.message-attachment-bar__heading {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  padding-right: var(--message-content-trailing-inset);
}

.message-attachment-bar h3 {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  padding: 9px 0 5px var(--message-content-inset);
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}

.message-attachment-bar__toggle {
  display: inline-flex;
  height: 24px;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  padding: 0 4px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.message-attachment-bar__toggle:hover {
  background: var(--control-hover-bg);
  color: var(--text);
}

.message-attachment-bar__toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.message-attachment-bar__list {
  flex: 0 1 auto;
  min-height: 0;
  margin: 0;
  padding: 0 8px var(--attachment-list-padding);
  overflow-y: auto;
  list-style: none;
}

.message-attachment-bar--collapsed .message-attachment-bar__list {
  max-height: calc(var(--attachment-first-row-height) + var(--attachment-list-padding));
  overflow-y: hidden;
}

.message-attachment-row--collapsed {
  /* AT-1.9: retain full-list geometry while collapsed rows are inert. */
  visibility: hidden;
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
  background: var(--control-hover-bg);
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
