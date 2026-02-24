<script setup>
import { computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth-store.js'
import { useEmailStore } from '../../stores/email-store.js'
import { useComposeStore } from '../../stores/compose-store.js'
import { useTheme } from '../../composables/useTheme.js'
import FolderList from './FolderList.vue'
import MessageList from './MessageList.vue'
import MessageDetail from './MessageDetail.vue'
import ComposePanel from './ComposePanel.vue'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const emailStore = useEmailStore()
const composeStore = useComposeStore()
const { theme, cycle } = useTheme()

const isComposing = computed(() => route.name === 'compose')
const folderName = computed(() => route.params.folderName || 'inbox')

const themeTitle = computed(() =>
  theme.value === 'system'
    ? 'Theme: system (click to light)'
    : theme.value === 'light'
      ? 'Theme: light (click to dark)'
      : 'Theme: dark (click to system)'
)

async function handleFolderChange(name) {
  if (!emailStore.initialized) return
  const success = await emailStore.switchMailboxByName(name)
  if (!success) {
    router.replace({ name: 'mailbox', params: { folderName: 'inbox' } })
  }
}

watch(folderName, handleFolderChange)

function handleKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && isComposing.value) {
    composeStore.send().then((ok) => {
      if (ok) router.push({ name: 'mailbox', params: { folderName: folderName.value } })
    })
  }
  if (e.key === 'Escape') {
    if (isComposing.value) {
      composeStore.resetCompose()
      router.push({ name: 'mailbox', params: { folderName: folderName.value } })
    } else if (emailStore.selectedEmailId) {
      emailStore.backToList()
    }
  }
}

onMounted(async () => {
  if (!emailStore.initialized) {
    await emailStore.initialize()
  }
  await handleFolderChange(folderName.value)

  document.addEventListener('keydown', handleKeydown)
  window.addEventListener('focus', emailStore.handleWindowFocus)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('focus', emailStore.handleWindowFocus)
})
</script>

<template>
  <header>
    <strong>Mail — {{ authStore.serverName }}</strong>
    <span class="spacer"></span>
    <button
      class="theme-toggle"
      @click="cycle"
      :title="themeTitle"
      aria-label="Theme: system/light/dark"
    >
      <svg
        v-if="theme === 'system'"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          d="M4 5h16a1 1 0 011 1v10a1 1 0 01-1 1h-6l1.5 2h-6L9 17H4a1 1 0 01-1-1V6a1 1 0 011-1zm1 2v8h14V7H5z"
        />
      </svg>
      <svg
        v-else-if="theme === 'light'"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.8 1.42-1.42zM1 13h3v-2H1v2zm10 10h2v-3h-2v3zm9-10v-2h-3v2h3zM6.76 19.16l-1.42 1.42-1.79-1.8 1.41-1.41 1.8 1.79zM13 1h-2v3h2V1zm7.66 3.46l-1.41-1.41-1.8 1.79 1.42 1.42 1.79-1.8zM12 6a6 6 0 100 12 6 6 0 000-12z"
        />
      </svg>
      <svg
        v-else
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M21.64 13a9 9 0 11-10.63-10.6A9 9 0 0021.64 13z" />
      </svg>
    </button>
    <button
      class="logout-btn"
      @click="authStore.handleLogout"
      title="Sign out"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          d="M5 5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h7v-2H5V5zm16 7l-4-4v3H9v2h8v3l4-4z"
        />
      </svg>
    </button>
    <div id="err" class="err" v-if="authStore.error">
      {{ authStore.error }}
    </div>
  </header>

  <main
    id="main"
    :class="
      !emailStore.selectedEmailId && !isComposing ? 'hide-detail' : ''
    "
  >
    <FolderList />
    <MessageList />
    <section class="detail">
      <ComposePanel v-if="isComposing" />
      <MessageDetail v-else />
    </section>
  </main>
</template>
