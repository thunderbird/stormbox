<script setup>
import { computed } from 'vue';
import { Paperclip, Star, RefreshCw } from 'lucide-vue-next';

import { useMailStore } from '../stores/mail-store.js';

const mailStore = useMailStore();

const folderName = computed(() => mailStore.currentFolder?.name ?? 'Mail');
const totalCount = computed(() => mailStore.currentFolder?.total_emails ?? null);

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
        <span v-if="totalCount != null" class="msg-list__count">{{ totalCount }} {{ totalCount === 1 ? 'message' : 'messages' }}</span>
      </div>
      <button class="msg-list__refresh" type="button" :title="mailStore.isLoading ? 'Refreshing…' : 'Refresh'" @click="mailStore.refresh()">
        <RefreshCw :size="16" :stroke-width="1.75" :class="{ 'is-spinning': mailStore.isLoading }" />
      </button>
    </header>

    <ol v-if="mailStore.messages.length > 0" class="msg-list__items">
      <li
        v-for="m in mailStore.messages"
        :key="m.id"
        :class="{
          'is-selected': mailStore.selectedMessageId === m.id,
          'is-unread': Number(m.is_seen) === 0,
        }"
      >
        <button class="msg-list__item" type="button" @click="open(m.id)">
          <span v-if="Number(m.is_unread) === 0 && Number(m.is_seen) === 0" class="msg-list__unread-dot" aria-label="Unread" />
          <span v-else-if="Number(m.is_seen) === 0" class="msg-list__unread-dot" aria-label="Unread" />
          <div class="msg-list__row1">
            <span class="msg-list__from">{{ shortFrom(m.from_text) }}</span>
            <span class="msg-list__date">{{ fmtDate(m.received_at) }}</span>
          </div>
          <div class="msg-list__row2">
            <span class="msg-list__subject">{{ m.subject || '(no subject)' }}</span>
            <span class="msg-list__icons">
              <Star v-if="Number(m.is_flagged) === 1" :size="13" :stroke-width="2" class="msg-list__star" />
              <Paperclip v-if="Number(m.has_attachment) === 1" :size="13" :stroke-width="1.75" class="msg-list__attach" />
            </span>
          </div>
          <p v-if="m.preview" class="msg-list__preview">{{ m.preview }}</p>
        </button>
      </li>
    </ol>

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
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--panel);
  min-width: 0;
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

.msg-list__items {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}
.msg-list__items li { position: relative; }
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
