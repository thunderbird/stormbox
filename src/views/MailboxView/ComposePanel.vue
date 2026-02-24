<script setup>
import { onMounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useComposeStore } from '../../stores/compose-store.js'
import { useEmailStore } from '../../stores/email-store.js'
import { useAuthStore } from '../../stores/auth-store.js'

const route = useRoute()
const router = useRouter()
const composeStore = useComposeStore()
const emailStore = useEmailStore()
const authStore = useAuthStore()

let quill = null

function ensureEditor() {
  import('quill').then(({ default: Quill }) => {
    const el = document.querySelector('#c-editor')
    if (!el) return

    quill = new Quill(el, {
      theme: 'snow',
      modules: {
        toolbar: [
          [{ header: [1, 2, false] }],
          ['bold', 'italic', 'underline'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['link', 'blockquote', 'code-block'],
          ['clean'],
        ],
      },
    })

    quill.on('text-change', () => {
      if (quill) {
        composeStore.compose.html = quill.root.innerHTML
        composeStore.compose.text = quill.getText()
      }
    })

    if (composeStore.compose.html) {
      quill.root.innerHTML = composeStore.compose.html
    } else if (composeStore.compose.text) {
      quill.setText(composeStore.compose.text)
    }

    quill.focus()
  })
}

onMounted(async () => {
  await nextTick()
  ensureEditor()
})

async function handleSend() {
  const success = await composeStore.send()
  if (success) {
    if (quill) quill.setText('')
    const folderName = route.params.folderName || 'inbox'
    router.push({ name: 'mailbox', params: { folderName } })
    if (emailStore.currentMailboxId === authStore.client?.ids?.sent) {
      emailStore.refreshCurrentMailbox()
    }
  }
}

function handleDiscard() {
  composeStore.resetCompose()
  if (quill) quill.setText('')
  const folderName = route.params.folderName || 'inbox'
  router.push({ name: 'mailbox', params: { folderName } })
}
</script>

<template>
  <div id="compose" class="compose visible">
    <div class="actions">
      <button
        id="c-send"
        type="button"
        :disabled="composeStore.sending"
        @click="handleSend"
        title="Send"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M22 2L11 13" />
          <path d="M22 2l-7 20-4-9-9-4 20-7z" />
        </svg>
        <span>Send</span>
      </button>

      <button
        id="c-cancel"
        type="button"
        @click="handleDiscard"
        title="Discard draft"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="3 6 5 6 21 6" />
          <path
            d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"
          />
          <path d="M10 11v6M14 11v6" />
          <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
        </svg>
        <span>Discard</span>
      </button>
    </div>

    <div class="row">
      <label>From</label>
      <select id="c-from" v-model="composeStore.compose.fromIdx">
        <option
          v-for="(id, idx) in composeStore.identities"
          :key="id.id"
          :value="idx"
        >
          {{ (id.name ? id.name + ' ' : '') + '<' + id.email + '>' }}
        </option>
      </select>
    </div>

    <div class="row">
      <label>To</label>
      <input
        id="c-to"
        v-model="composeStore.compose.to"
        placeholder="alice@example.com, Bob <bob@example.com>"
      />
    </div>

    <div class="row">
      <label>Subject</label>
      <input
        id="c-subj"
        v-model="composeStore.compose.subject"
        placeholder="Subject"
      />
    </div>

    <div class="row">
      <label>Body</label>
      <div id="c-editor" class="editor"></div>
    </div>

    <div class="meta" id="c-status">{{ composeStore.composeStatus }}</div>
    <pre
      id="c-debug"
      class="debug"
      style="display: block; white-space: pre-wrap"
      v-if="composeStore.composeDebug"
    >
      {{ composeStore.composeDebug }}
    </pre>
  </div>
</template>

<style scoped>
.compose {
  border-bottom: 1px solid var(--border);
  padding: 12px 16px;
}

.compose .row {
  grid-template-columns: 80px minmax(0, 1fr);
}

.compose .row > * {
  min-width: 0;
}

.compose .row input,
.compose .row select {
  width: 100%;
}

.compose .actions {
  display: flex;
  gap: 0.6rem;
  justify-content: flex-start;
  order: -1;
  padding: 0 0 8px 0;
}

.compose .actions button {
  padding: 0.55rem 0.9rem;
  border: 0;
  border-radius: 0.6rem;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
}

.compose .actions svg {
  width: 16px;
  height: 16px;
  display: block;
}

.compose .actions button:hover {
  filter: brightness(1.08);
}

.compose .actions #c-send[disabled] {
  opacity: 0.6;
  cursor: not-allowed;
}

#c-to,
#c-subj,
#c-from {
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--panel2);
  color: var(--text);
}

.debug {
  max-height: 35vh;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--border);
  background: #0e1220;
  border-radius: 0.5rem;
}

#c-editor {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  min-height: 320px;
  grid-column: 2 / 3;
}

#c-editor :deep(.ql-toolbar),
#c-editor :deep(.ql-container),
#c-editor :deep(.ql-editor) {
  width: 100%;
}

#c-editor :deep(.ql-container) {
  flex: 1 1 auto;
  min-height: 280px;
}

#c-editor :deep(.ql-toolbar) {
  background: var(--panel2);
  border: 1px solid var(--border);
  border-radius: 0.5rem 0.5rem 0 0;
}

#c-editor :deep(.ql-container) {
  background: var(--panel2);
  border: 1px solid var(--border);
  border-top: 0;
  border-radius: 0 0 0.5rem 0.5rem;
}

#c-editor :deep(.ql-editor) {
  color: var(--text);
}
</style>
