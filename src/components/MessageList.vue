<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { Paperclip, Star, RefreshCw } from 'lucide-vue-next';

import { useMailStore } from '../stores/mail-store.js';

const mailStore = useMailStore();

const folderName = computed(() => mailStore.currentFolder?.name ?? 'Mail');

// Virtualiser count is the FOLDER TOTAL, not loaded count. That way
// the scrollbar reflects reality from the very first round trip and
// the user can scroll into "unloaded" territory; placeholders render
// there until ensureLoaded() pulls the matching page.
const rowCount = computed(() => Math.max(
  mailStore.totalForFolder ?? 0,
  mailStore.messages.length,
));

const ROW_HEIGHT = 88;
const scrollEl = ref(null);

const virtualizer = useVirtualizer(
  computed(() => ({
    count: rowCount.value,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (i) => mailStore.messages[i]?.id ?? `_ph_${i}`,
  })),
);

const totalSize = computed(() => virtualizer.value.getTotalSize());
const virtualItems = computed(() => virtualizer.value.getVirtualItems());

// Throttle the scroll-driven fetch. Old stormbox used a 100ms guard so
// a fast scroll doesn't fire 50 round trips.
let lastPrefetch = 0;
watch(virtualItems, (items) => {
  if (!items.length) return;
  const folderId = mailStore.currentFolderId;
  if (folderId == null) return;
  const first = items[0].index;
  const last = items[items.length - 1].index;
  // Always update the requested range so the inflight-page chain in
  // mail-store can re-pump against the latest visible window.
  mailStore.setRequestedRange(folderId, first, last + 1);
  const now = performance.now();
  if (now - lastPrefetch < 100) return;
  lastPrefetch = now;
  mailStore.ensureLoaded(first, last + 1);
});

// Persist scroll position per folder. rAF-throttled so we don't write
// on every pixel.
let scrollWriteScheduled = false;
function onScroll() {
  if (scrollWriteScheduled) return;
  scrollWriteScheduled = true;
  requestAnimationFrame(() => {
    scrollWriteScheduled = false;
    const folderId = mailStore.currentFolderId;
    if (folderId != null && scrollEl.value) {
      mailStore.setScrollTop(folderId, scrollEl.value.scrollTop);
    }
  });
}

watch(
  () => mailStore.currentFolderId,
  async (id) => {
    virtualizer.value.measure();
    if (id == null) return;
    // Wait for the new folder's rows to bind before restoring scroll;
    // the scroller's scrollHeight needs to reflect the new totalSize
    // so the assignment doesn't get clamped.
    await nextTick();
    if (scrollEl.value) {
      scrollEl.value.scrollTop = mailStore.getScrollTop(id);
    }
  },
  { immediate: true },
);

onMounted(() => {
  virtualizer.value.measure();
});

async function open(id) { await mailStore.selectMessage(id); }

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.valueOf())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
}

function shortFrom(text) {
  if (!text) return '(no sender)';
  const m = text.match(/^(.+?)\s*<.+>$/);
  return m ? m[1].replace(/^"|"$/g, '') : text;
}
</script>

<template>
  <section class="msg-list" aria-label="Messages">
    <header class="msg-list__header">
      <div class="msg-list__title">
        <h2>{{ folderName }}</h2>
        <span v-if="rowCount > 0" class="msg-list__count">
          {{ rowCount }} {{ rowCount === 1 ? 'message' : 'messages' }}
        </span>
      </div>
      <button
        class="msg-list__refresh"
        type="button"
        :title="mailStore.isLoading ? 'Refreshing…' : 'Refresh'"
        @click="mailStore.refresh()"
      >
        <RefreshCw :size="16" :stroke-width="1.75" :class="{ 'is-spinning': mailStore.isLoading }" />
      </button>
    </header>

    <div
      v-if="rowCount > 0"
      ref="scrollEl"
      class="msg-list__scroller"
      @scroll="onScroll"
    >
      <div
        v-if="mailStore.isLoading && mailStore.messages.length === 0"
        class="msg-list__loader"
      >
        <RefreshCw :size="18" class="is-spinning" />
        <p>Loading {{ folderName }}…</p>
      </div>
      <ol class="msg-list__items" :style="{ height: totalSize + 'px' }">
        <template v-for="v in virtualItems" :key="v.key">
          <li
            v-if="mailStore.messages[v.index]"
            :data-index="v.index"
            :class="{
              'is-selected': mailStore.selectedMessageId === mailStore.messages[v.index].id,
              'is-unread': Number(mailStore.messages[v.index].is_seen) === 0,
            }"
            :style="{
              position: 'absolute',
              top: '0px',
              left: '0px',
              right: '0px',
              transform: `translateY(${v.start}px)`,
              height: v.size + 'px',
            }"
          >
            <button
              class="msg-list__item"
              type="button"
              @click="open(mailStore.messages[v.index].id)"
            >
              <span
                v-if="Number(mailStore.messages[v.index].is_seen) === 0"
                class="msg-list__unread-dot"
                aria-label="Unread"
              />
              <div class="msg-list__row1">
                <span class="msg-list__from">{{ shortFrom(mailStore.messages[v.index].from_text) }}</span>
                <span class="msg-list__date">{{ fmtDate(mailStore.messages[v.index].received_at) }}</span>
              </div>
              <div class="msg-list__row2">
                <span class="msg-list__subject">{{ mailStore.messages[v.index].subject || '(no subject)' }}</span>
                <span class="msg-list__icons">
                  <Star v-if="Number(mailStore.messages[v.index].is_flagged) === 1" :size="13" :stroke-width="2" class="msg-list__star" />
                  <Paperclip v-if="Number(mailStore.messages[v.index].has_attachment) === 1" :size="13" :stroke-width="1.75" class="msg-list__attach" />
                </span>
              </div>
              <p v-if="mailStore.messages[v.index].preview" class="msg-list__preview">
                {{ mailStore.messages[v.index].preview }}
              </p>
            </button>
          </li>
          <li
            v-else
            :data-index="v.index"
            :data-placeholder="true"
            class="msg-list__item--placeholder"
            :style="{
              position: 'absolute',
              top: '0px',
              left: '0px',
              right: '0px',
              transform: `translateY(${v.start}px)`,
              height: v.size + 'px',
            }"
          >
            <div class="msg-list__skeleton">
              <div class="msg-list__skel-line msg-list__skel-line--from" />
              <div class="msg-list__skel-line msg-list__skel-line--subject" />
              <div class="msg-list__skel-line msg-list__skel-line--preview" />
            </div>
          </li>
        </template>
      </ol>
    </div>

    <div v-else-if="mailStore.isLoading" class="msg-list__placeholder">
      <RefreshCw :size="18" class="is-spinning" />
      <p>Loading {{ folderName }}…</p>
    </div>
    <div v-else-if="mailStore.currentFolderId" class="msg-list__placeholder">
      <p>{{ folderName }} is empty.</p>
    </div>
    <div v-else class="msg-list__placeholder">
      <p>Select a folder to view its messages.</p>
    </div>
  </section>
</template>

<style scoped>
.msg-list {
  display: grid;
  grid-template-rows: auto 1fr;
  border-right: 1px solid var(--border);
  background: var(--panel);
  min-width: 0;
  min-height: 0;
  height: 100%;
}
.msg-list__header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.msg-list__title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.msg-list__title h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.msg-list__count {
  font-size: 11px;
  color: var(--muted);
  margin-top: 1px;
}
.msg-list__refresh {
  background: transparent;
  border: 0;
  color: var(--muted);
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  cursor: pointer;
}
.msg-list__refresh:hover {
  background: var(--rowHover);
  color: var(--text);
}
.is-spinning {
  animation: msg-spin 1.2s linear infinite;
}
@keyframes msg-spin {
  to { transform: rotate(360deg); }
}

.msg-list__scroller {
  position: relative;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
  contain: strict;
  will-change: scroll-position;
}
.msg-list__loader {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: var(--panel);
  color: var(--muted);
  font-size: 13px;
}
.msg-list__loader p { margin: 0; }
.msg-list__items {
  list-style: none;
  margin: 0;
  padding: 0;
  position: relative;
  width: 100%;
}
.msg-list__items li.is-selected .msg-list__item { background: var(--rowActive); }
.msg-list__items li.is-unread .msg-list__from,
.msg-list__items li.is-unread .msg-list__subject {
  font-weight: 600;
  color: var(--text);
}

.msg-list__item {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  text-align: left;
  padding: 10px 14px 10px 22px;
  border: 0;
  background: transparent;
  cursor: pointer;
  border-bottom: 1px solid var(--border-soft);
  font: inherit;
  color: inherit;
  transition: background 0.06s ease;
}
.msg-list__item:hover { background: var(--rowHover); }

.msg-list__unread-dot {
  position: absolute;
  left: 9px;
  top: 16px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}

.msg-list__row1, .msg-list__row2 {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.msg-list__row1 { margin-bottom: 2px; }
.msg-list__from {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-list__date {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.msg-list__subject {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-list__icons {
  display: inline-flex;
  gap: 4px;
  color: var(--muted);
  flex-shrink: 0;
}
.msg-list__star { color: #f5b700; }
.msg-list__preview {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.35;
}

.msg-list__item--placeholder {
  border-bottom: 1px solid var(--border-soft);
  padding: 10px 14px 10px 22px;
}
.msg-list__skeleton {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  justify-content: center;
}
.msg-list__skel-line {
  height: 10px;
  border-radius: 4px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--text) 6%, transparent) 0%,
    color-mix(in srgb, var(--text) 12%, transparent) 50%,
    color-mix(in srgb, var(--text) 6%, transparent) 100%
  );
  background-size: 200% 100%;
  animation: skel-shimmer 1.4s linear infinite;
}
.msg-list__skel-line--from { width: 35%; }
.msg-list__skel-line--subject { width: 75%; }
.msg-list__skel-line--preview { width: 90%; height: 8px; }
@keyframes skel-shimmer {
  to { background-position: -200% 0; }
}

.msg-list__placeholder {
  margin: 0;
  padding: 32px 24px;
  color: var(--muted);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  text-align: center;
}
.msg-list__placeholder p { margin: 0; }
</style>
