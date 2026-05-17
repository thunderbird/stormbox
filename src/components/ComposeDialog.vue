<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue';
import Squire from 'squire-rte';

import { useComposeStore } from '../stores/compose-store.js';
import { useContactsStore } from '../stores/contacts-store.js';
import { COMPOSE_STATE } from '../constants/states.js';

const composeStore = useComposeStore();
const contactsStore = useContactsStore();

const editorEl = ref(null);
let squire = null;

onMounted(() => {
  if (!editorEl.value) return;
  squire = new Squire(editorEl.value);
  squire.setHTML(composeStore.draft.htmlBody || '<p><br></p>');
  squire.addEventListener('input', () => {
    composeStore.draft.htmlBody = squire.getHTML();
    composeStore.draft.textBody = editorEl.value.innerText;
  });
});

watch(() => composeStore.isOpen, (open) => {
  if (open && squire) {
    squire.setHTML(composeStore.draft.htmlBody || '<p><br></p>');
  }
});

onUnmounted(() => {
  squire?.destroy?.();
  squire = null;
});

const autocompleteSuggestions = ref([]);
const autocompleteFor = ref(null);

async function onRecipientInput(field) {
  autocompleteFor.value = field;
  const value = composeStore.draft[field];
  const lastTokenMatch = value.match(/(?:^|,)\s*([^,]+)$/);
  const prefix = (lastTokenMatch?.[1] ?? '').trim();
  if (prefix.length < 2) {
    autocompleteSuggestions.value = [];
    return;
  }
  autocompleteSuggestions.value = await contactsStore.autocomplete(prefix, 8);
}

function applySuggestion(field, candidate) {
  const value = composeStore.draft[field];
  const lastTokenIdx = value.lastIndexOf(',');
  const prefix = lastTokenIdx >= 0 ? value.slice(0, lastTokenIdx + 1) + ' ' : '';
  const formatted = candidate.name
    ? `${candidate.name} <${candidate.email}>`
    : candidate.email;
  composeStore.draft[field] = `${prefix}${formatted}, `;
  autocompleteSuggestions.value = [];
}

async function send() {
  await composeStore.send();
}
</script>

<template>
  <div v-if="composeStore.isOpen" class="compose-dialog" role="dialog" aria-label="Compose">
    <div class="compose-dialog__card">
      <header>
        <h2>{{ composeStore.draft.subject || 'New Message' }}</h2>
        <button type="button" class="icon" @click="composeStore.close()" aria-label="Close">×</button>
      </header>

      <div class="row">
        <label>From</label>
        <select v-model="composeStore.draft.fromIdx">
          <option v-for="(id, idx) in composeStore.identities" :key="id.id" :value="idx">
            {{ id.name ? `${id.name} <${id.email}>` : id.email }}
          </option>
        </select>
      </div>

      <div class="row">
        <label>To</label>
        <input
          type="text"
          v-model="composeStore.draft.to"
          @input="onRecipientInput('to')"
          autocomplete="off"
        />
      </div>
      <ul v-if="autocompleteFor === 'to' && autocompleteSuggestions.length > 0" class="autocomplete">
        <li v-for="s in autocompleteSuggestions" :key="`${s.email}-${s.source}`">
          <button type="button" @click="applySuggestion('to', s)">
            <span class="ac-name">{{ s.name || s.email }}</span>
            <span class="ac-email">{{ s.email }}</span>
            <span class="ac-source">{{ s.source }}</span>
          </button>
        </li>
      </ul>

      <div class="row">
        <label>Subject</label>
        <input type="text" v-model="composeStore.draft.subject" />
      </div>

      <div class="editor-wrap">
        <div ref="editorEl" class="editor" contenteditable="true" />
      </div>

      <footer>
        <button type="button" class="secondary" @click="composeStore.close()">Discard</button>
        <button type="button" class="primary" :disabled="composeStore.status === COMPOSE_STATE.SENDING" @click="send">
          {{ composeStore.status === COMPOSE_STATE.SENDING ? 'Sending…' : 'Send' }}
        </button>
      </footer>

      <p v-if="composeStore.error" class="compose-error">{{ composeStore.error }}</p>
    </div>
  </div>
</template>

<style scoped>
.compose-dialog {
  position: fixed;
  inset: 0;
  background: rgba(13, 22, 42, 0.4);
  display: grid;
  place-items: center;
  z-index: 50;
}
.compose-dialog__card {
  width: min(720px, 92vw);
  height: min(640px, 90vh);
  background: var(--surface, #fff);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  padding: 16px;
  gap: 8px;
}
.compose-dialog__card header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.compose-dialog__card header h2 { margin: 0; font-size: 16px; }
.icon {
  background: transparent;
  border: 0;
  font-size: 24px;
  cursor: pointer;
  color: inherit;
}
.row {
  display: grid;
  grid-template-columns: 70px 1fr;
  gap: 8px;
  align-items: center;
}
.row label {
  font-size: 12px;
  color: var(--muted, #6b7388);
}
.row input, .row select {
  padding: 7px 10px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
  font-size: 14px;
}
.editor-wrap {
  flex: 1;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
  padding: 8px;
  overflow-y: auto;
  min-height: 0;
}
.editor {
  min-height: 100%;
  outline: none;
  font-size: 14px;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.primary { background: #2563eb; color: #fff; border: 0; padding: 8px 14px; border-radius: 8px; cursor: pointer; }
.secondary { background: transparent; color: #555; border: 1px solid var(--border, #d6d9e2); padding: 8px 14px; border-radius: 8px; cursor: pointer; }
.autocomplete {
  margin: 0 0 0 78px;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
  max-height: 200px;
  overflow-y: auto;
}
.autocomplete button {
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  padding: 8px 10px;
  cursor: pointer;
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 8px;
  align-items: baseline;
}
.autocomplete button:hover { background: rgba(0, 0, 0, 0.04); }
.ac-name { font-size: 13px; }
.ac-email { font-size: 12px; color: var(--muted, #6b7388); }
.ac-source { font-size: 11px; color: var(--muted, #6b7388); text-transform: uppercase; }
.compose-error { color: #b3261e; font-size: 13px; }
</style>
