<script setup>
import { computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useEmailStore } from '../../stores/email-store.js'

const router = useRouter()
const route = useRoute()
const emailStore = useEmailStore()

const unreadBadge = (m) =>
  typeof m.unreadEmails === 'number' && m.unreadEmails > 0
    ? ` • ${m.unreadEmails}`
    : ''

const byName = (a, b) =>
  emailStore.displayName(a).localeCompare(emailStore.displayName(b))

const orderedTop = computed(() => {
  const pick = (role, names) =>
    emailStore.mailboxes.find(
      (x) => (x.role || '').toLowerCase() === role
    ) ||
    emailStore.mailboxes.find((x) =>
      names.includes((x.name || '').toLowerCase())
    )
  return [
    pick('inbox', ['inbox']),
    pick('archive', ['archive', 'archives']),
    pick('drafts', ['drafts']),
    pick('sent', ['sent', 'sent items']),
    pick('junk', ['junk', 'spam']),
    pick('trash', ['trash', 'deleted items']),
  ].filter(Boolean)
})

const orderedOther = computed(() => {
  const picked = new Set(orderedTop.value.map((x) => x.id))
  return emailStore.mailboxes
    .filter((m) => !picked.has(m.id) && (m.role || '') !== 'outbox')
    .slice()
    .sort(byName)
})

function navigateToMailbox(m) {
  const name = emailStore.getMailboxUrlName(m)
  router.push({ name: 'mailbox', params: { folderName: name } })
}

function navigateToCompose() {
  const folderName = route.params.folderName || 'inbox'
  router.push({ name: 'compose', params: { folderName } })
}
</script>

<template>
  <aside class="folders">
    <div class="ftools">
      <button id="composeBtn" title="Compose" @click="navigateToCompose">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 20h9" />
          <path
            d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"
          />
        </svg>
        <span>Compose</span>
      </button>
      <button
        id="reload"
        title="Reload"
        @click="emailStore.refreshCurrentMailbox"
      >
        Reload
      </button>
    </div>

    <div class="fscroll">
      <div id="foldersTop">
        <div
          v-for="m in orderedTop"
          :key="m.id"
          class="mbox"
          :class="[
            { active: m.id === emailStore.currentMailboxId },
            { unread: (m.unreadEmails || 0) > 0 },
          ]"
          @click="navigateToMailbox(m)"
        >
          <div class="name">{{ emailStore.displayName(m) }}</div>
          <div class="count" v-html="unreadBadge(m)"></div>
        </div>
      </div>

      <div
        id="otherHeader"
        class="title"
        v-show="orderedOther.length"
      >
        Folders
      </div>
      <div id="foldersOther">
        <div
          v-for="m in orderedOther"
          :key="m.id"
          class="mbox"
          :class="[
            { active: m.id === emailStore.currentMailboxId },
            { unread: (m.unreadEmails || 0) > 0 },
          ]"
          @click="navigateToMailbox(m)"
        >
          <div class="name">{{ emailStore.displayName(m) }}</div>
          <div class="count" v-html="unreadBadge(m)"></div>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.folders {
  border-right: 1px solid var(--border);
  display: grid;
  grid-template-rows: auto 1fr;
  background: var(--panel2);
  min-height: 0;
}

.ftools {
  display: flex;
  gap: 0.5rem;
  padding: 8px;
  border-bottom: 1px solid var(--border);
}

.ftools button {
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

.ftools button:hover {
  filter: brightness(1.08);
}

.ftools svg {
  width: 16px;
  height: 16px;
  display: block;
}

.fscroll {
  overflow: auto;
  min-height: 0;
}

#foldersTop,
#foldersOther {
  padding: 6px;
  overflow: visible;
}

.title {
  padding: 10px 12px;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  font-weight: 600;
}

.mbox {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 0.5rem;
  cursor: pointer;
}

.mbox:hover {
  background: var(--rowHover);
}

.mbox.active {
  background: var(--rowActive);
}

.mbox .name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mbox .count {
  color: var(--muted);
  font-size: 12px;
}

.mbox.unread .name {
  font-weight: 700;
  color: var(--text);
}

.mbox.unread .count {
  font-weight: 700;
  color: var(--text);
}
</style>
