<script setup>
import { computed } from 'vue';
import { useMailStore } from '../stores/mail-store.js';

const mailStore = useMailStore();

const folderName = computed(() => mailStore.currentFolder?.name ?? '');
const messages = computed(() => mailStore.messages);

async function open(id) {
  await mailStore.selectMessage(id);
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.valueOf())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString();
}

function shortFrom(text) {
  if (!text) return '';
  const m = text.match(/^(.+?)\s*<.+>$/);
  return m ? m[1] : text;
}
</script>

<template>
  <section class="message-list" aria-label="Messages">
    <header class="message-list__header">
      <h2>{{ folderName }}</h2>
      <span class="message-list__count">{{ messages.length }} loaded</span>
    </header>
    <ol v-if="messages.length > 0" class="message-list__items">
      <li
        v-for="m in messages"
        :key="m.id"
        :class="{ 'is-selected': mailStore.selectedMessageId === m.id, 'is-unread': Number(m.is_seen) === 0 }"
      >
        <button class="message-list__item" type="button" @click="open(m.id)">
          <div class="message-list__row1">
            <span class="message-list__from">{{ shortFrom(m.from_text) || '(no sender)' }}</span>
            <span class="message-list__date">{{ fmtDate(m.received_at) }}</span>
          </div>
          <div class="message-list__row2">
            <span class="message-list__subject">{{ m.subject || '(no subject)' }}</span>
          </div>
          <p v-if="m.preview" class="message-list__preview">{{ m.preview }}</p>
        </button>
      </li>
    </ol>
    <p v-else-if="!mailStore.currentFolderId" class="message-list__placeholder">Select a folder to view its messages.</p>
    <p v-else class="message-list__placeholder">
      No messages in this folder yet.
      <button class="link" type="button" @click="mailStore.refresh()">Refresh</button>
    </p>
  </section>
</template>

<style scoped>
.message-list {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border, #e3e6ee);
  background: var(--surface, #fff);
  min-width: 0;
}
.message-list__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border, #e3e6ee);
}
.message-list__header h2 {
  margin: 0;
  font-size: 15px;
}
.message-list__count {
  font-size: 12px;
  color: var(--muted, #6b7388);
}
.message-list__items {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}
.message-list__item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px 16px;
  border: 0;
  background: transparent;
  cursor: pointer;
  border-bottom: 1px solid var(--border-soft, #eef0f5);
  font: inherit;
  color: inherit;
}
.message-list__item:hover { background: rgba(0, 0, 0, 0.03); }
li.is-selected .message-list__item {
  background: var(--accent-bg, #e2e9fb);
}
li.is-unread .message-list__item .message-list__from,
li.is-unread .message-list__item .message-list__subject { font-weight: 600; }
.message-list__row1, .message-list__row2 {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: baseline;
}
.message-list__from { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.message-list__date { color: var(--muted, #6b7388); font-size: 12px; flex-shrink: 0; }
.message-list__subject { font-size: 14px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.message-list__preview {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--muted, #6b7388);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.message-list__placeholder {
  margin: 0;
  padding: 24px;
  color: var(--muted, #6b7388);
}
.link {
  background: none;
  border: 0;
  color: #2563eb;
  cursor: pointer;
  text-decoration: underline;
}
</style>
