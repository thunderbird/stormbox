<script setup>
import { computed, watch, ref, onUnmounted } from 'vue';
import DOMPurify from 'dompurify';

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
        <button class="message-view__back" type="button" @click="backToList" aria-label="Back to list">←</button>
        <div class="message-view__title">
          <h2>{{ message.subject || '(no subject)' }}</h2>
          <p class="message-view__meta">
            <span>{{ message.from_text }}</span>
            <span class="message-view__date">{{ fmtDate(message.received_at) }}</span>
          </p>
        </div>
        <div class="message-view__actions">
          <button type="button" @click="reply">Reply</button>
          <button type="button" class="danger" @click="destroy">Delete</button>
        </div>
      </header>
      <div class="message-view__body">
        <div v-if="sanitizedHtml" class="message-view__html" v-html="sanitizedHtml" />
        <pre v-else-if="body?.text" class="message-view__text">{{ body.text }}</pre>
        <p v-else class="message-view__placeholder">Loading message…</p>
        <ul v-if="body?.attachments?.length" class="message-view__attachments">
          <li v-for="a in body.attachments" :key="a.part_id">
            <span class="att-name">{{ a.name || '(unnamed)' }}</span>
            <span class="att-meta">{{ a.mime_type || '?' }} · {{ a.size ? `${Math.ceil(a.size / 1024)} KB` : '' }}</span>
          </li>
        </ul>
      </div>
    </article>
  </section>
</template>

<style scoped>
.message-view {
  background: var(--surface, #fff);
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.message-view__empty {
  display: grid;
  place-items: center;
  height: 100%;
  color: var(--muted, #6b7388);
}
.message-view__header {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 16px;
  border-bottom: 1px solid var(--border, #e3e6ee);
}
.message-view__back {
  background: transparent;
  border: 1px solid var(--border, #e3e6ee);
  border-radius: 8px;
  width: 32px;
  height: 32px;
  cursor: pointer;
}
.message-view__title { flex: 1; min-width: 0; }
.message-view__title h2 { margin: 0; font-size: 18px; }
.message-view__meta {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--muted, #6b7388);
  display: flex;
  gap: 12px;
}
.message-view__date { margin-left: auto; }
.message-view__actions {
  display: flex;
  gap: 8px;
}
.message-view__actions button {
  border: 1px solid var(--border, #e3e6ee);
  background: var(--surface, #fff);
  padding: 7px 12px;
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
}
.message-view__actions .danger { color: #b3261e; border-color: #f1c4c0; }
.message-view__body {
  padding: 16px;
  overflow-y: auto;
  min-height: 0;
}
.message-view__text {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
}
.message-view__html :deep(img) { max-width: 100%; height: auto; }
.message-view__attachments {
  list-style: none;
  margin: 16px 0 0;
  padding: 12px;
  border-top: 1px solid var(--border, #e3e6ee);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.message-view__attachments li {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 13px;
}
.att-name { font-weight: 500; }
.att-meta { color: var(--muted, #6b7388); }
.message-view__placeholder { margin: 0; color: var(--muted, #6b7388); }
</style>
