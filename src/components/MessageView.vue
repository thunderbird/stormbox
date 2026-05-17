<script setup>
import { computed, watch, ref, onUnmounted } from 'vue';
import DOMPurify from 'dompurify';
import { ArrowLeft, CornerUpLeft, Trash2, Paperclip } from 'lucide-vue-next';

import { useMailStore } from '../stores/mail-store.js';
import { useComposeStore } from '../stores/compose-store.js';

const mailStore = useMailStore();
const composeStore = useComposeStore();

const sanitizedHtml = ref('');

const body = computed(() => mailStore.messageBody);
const message = computed(() =>
  mailStore.messages.find((m) => m.id === mailStore.selectedMessageId) ?? null,
);

watch(body, (next) => {
  if (!next?.html) {
    sanitizedHtml.value = '';
    return;
  }
  sanitizedHtml.value = DOMPurify.sanitize(next.html, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
}, { immediate: true });

onUnmounted(() => {
  sanitizedHtml.value = '';
});

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  return Number.isNaN(d.valueOf()) ? '' : d.toLocaleString();
}

function backToList() {
  mailStore.selectMessage(null);
}

async function reply() {
  if (!message.value) return;
  composeStore.prepareReply({
    to: message.value.from_text ?? '',
    subject: makeReplySubject(message.value.subject),
    text: body.value?.text ?? '',
    html: body.value?.html ?? '',
  });
}

function makeReplySubject(subject) {
  const s = (subject ?? '').trim();
  if (/^re:/i.test(s)) return s;
  return s ? `Re: ${s}` : 'Re: (no subject)';
}

async function destroy() {
  if (!message.value) return;
  await mailStore.destroyMessage(message.value.id);
}
</script>

<template>
  <section class="message-view" aria-label="Message detail">
    <div v-if="!message" class="message-view__empty">
      <p>Select a message to read it.</p>
    </div>
    <article v-else>
      <header class="message-view__header">
        <button class="message-view__icon-btn" type="button" @click="backToList" aria-label="Back to list">
          <ArrowLeft :size="16" :stroke-width="1.75" />
        </button>
        <div class="message-view__title">
          <h2>{{ message.subject || '(no subject)' }}</h2>
          <p class="message-view__meta">
            <span class="message-view__from">{{ message.from_text }}</span>
            <span class="message-view__date">{{ fmtDate(message.received_at) }}</span>
          </p>
        </div>
        <div class="message-view__actions">
          <button class="message-view__action" type="button" @click="reply" title="Reply">
            <CornerUpLeft :size="16" :stroke-width="1.75" />
            <span>Reply</span>
          </button>
          <button class="message-view__action message-view__action--danger" type="button" @click="destroy" title="Delete">
            <Trash2 :size="16" :stroke-width="1.75" />
          </button>
        </div>
      </header>
      <div class="message-view__body">
        <div v-if="sanitizedHtml" class="message-view__html" v-html="sanitizedHtml" />
        <pre v-else-if="body?.text" class="message-view__text">{{ body.text }}</pre>
        <p v-else class="message-view__placeholder">Loading message…</p>
        <ul v-if="body?.attachments?.length" class="message-view__attachments">
          <li v-for="a in body.attachments" :key="a.part_id">
            <Paperclip :size="14" :stroke-width="1.75" class="message-view__att-icon" />
            <span class="att-name">{{ a.name || '(unnamed)' }}</span>
            <span class="att-meta">{{ a.mime_type || '?' }}{{ a.size ? ` · ${Math.ceil(a.size / 1024)} KB` : '' }}</span>
          </li>
        </ul>
      </div>
    </article>
  </section>
</template>

<style scoped>
.message-view {
  background: var(--panel);
  display: grid;
  grid-template-rows: auto 1fr;
  min-width: 0;
  min-height: 0;
  height: 100%;
}
.message-view__empty {
  display: grid;
  place-items: center;
  height: 100%;
  color: var(--muted);
}
.message-view__header {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.message-view__icon-btn {
  background: transparent;
  border: 0;
  border-radius: 8px;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  color: var(--muted);
  cursor: pointer;
  flex-shrink: 0;
}
.message-view__icon-btn:hover { background: var(--rowHover); color: var(--text); }
.message-view__title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.message-view__title h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.message-view__meta {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  display: flex;
  gap: 12px;
  align-items: baseline;
}
.message-view__from {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.message-view__date { flex-shrink: 0; font-variant-numeric: tabular-nums; }
.message-view__actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.message-view__action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--text);
  padding: 7px 11px;
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}
.message-view__action:hover { background: var(--rowHover); }
.message-view__action--danger:hover { background: rgba(255, 107, 107, 0.12); color: #ff6b6b; }

.message-view__body {
  padding: 18px 22px;
  overflow-y: auto;
  min-height: 0;
}
.message-view__text {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  color: var(--text);
}
.message-view__html { color: var(--text); line-height: 1.55; }
.message-view__html :deep(img) { max-width: 100%; height: auto; }
.message-view__html :deep(a) { color: var(--accent); }
.message-view__html :deep(blockquote) {
  border-left: 3px solid var(--border);
  margin: 8px 0;
  padding: 4px 12px;
  color: var(--muted);
}
.message-view__attachments {
  list-style: none;
  margin: 18px 0 0;
  padding: 12px 0 0;
  border-top: 1px solid var(--border-soft);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.message-view__attachments li {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  padding: 6px 8px;
  border-radius: 6px;
}
.message-view__attachments li:hover { background: var(--rowHover); }
.message-view__att-icon { color: var(--muted); }
.att-name { font-weight: 500; color: var(--text); }
.att-meta { color: var(--muted); font-size: 12px; }
.message-view__placeholder { margin: 0; color: var(--muted); }
</style>
