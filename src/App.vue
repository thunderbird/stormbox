<script>
import { ref, computed, onMounted } from 'vue'
import { useEmailStore } from './composables/useEmailStore.js'
import { useTheme } from './composables/useTheme.js'
import { initOidc, getOidc } from './services/auth.js'
import { JMAP_SERVER_URL } from './defines.js'
import LoginForm from './components/LoginForm.vue'
import FolderList from './components/FolderList.vue'
import MessageList from './components/MessageList.vue'
import ComposePanel from './components/ComposePanel.vue'
import MessageDetail from './components/MessageDetail.vue'

export default {
  name: 'App',
  components: {
    LoginForm,
    FolderList,
    MessageList,
    ComposePanel,
    MessageDetail
  },
  setup() {
    const emailStore = useEmailStore()
    const { theme, cycle } = useTheme()

    const oidcReady = ref(false)
    const oidcLoading = ref(true)

    const serverName = computed(() => {
      const url = JMAP_SERVER_URL
      try {
        return new URL(url).hostname
      } catch {
        return url
      }
    })

    const handleOAuthLogin = async () => {
      const oidc = getOidc()
      if (!oidc) return
      if (!oidc.isUserLoggedIn) {
        await oidc.login()
        return
      }
      await emailStore.connectWithOAuth(oidc)
    }

    const handleLogout = async () => {
      const oidc = getOidc()
      if (oidc && oidc.isUserLoggedIn) {
        await oidc.logout({ redirectTo: "home" })
      } else {
        window.location.reload()
      }
    }

    onMounted(async () => {
      try {
        const oidc = await initOidc()
        oidcReady.value = true
        oidcLoading.value = false

        if (oidc.isUserLoggedIn) {
          await emailStore.connectWithOAuth(oidc)
        }
      } catch (e) {
        console.error('OIDC initialization failed:', e)
        oidcLoading.value = false
      }
    })

    return {
      ...emailStore,
      oidcReady,
      oidcLoading,
      handleOAuthLogin,
      handleLogout,
      currentTheme: theme,
      cycle,
      serverName,
      themeTitle: computed(() => theme.value === 'system' ? 'Theme: system (click to light)' : (theme.value === 'light' ? 'Theme: light (click to dark)' : 'Theme: dark (click to system)'))
    }
  }
}
</script>

<template>
  <div id="app">
    <!-- Login Form -->
    <LoginForm :connected="connected" :status="status" :error="error" :oidc-ready="oidcReady" :oidc-loading="oidcLoading" @connect="connect" @oauth-login="handleOAuthLogin" />

    <!-- Header -->
    <header v-if="connected">
      <strong>Mail — {{ serverName }}</strong>
      <span class="spacer"></span>
      <button class="theme-toggle" @click="cycle" :title="themeTitle" aria-label="Theme: system/light/dark">
        <!-- System icon (computer) -->
        <svg v-if="currentTheme === 'system'" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"
          aria-hidden="true">
          <path d="M4 5h16a1 1 0 011 1v10a1 1 0 01-1 1h-6l1.5 2h-6L9 17H4a1 1 0 01-1-1V6a1 1 0 011-1zm1 2v8h14V7H5z" />
        </svg>
        <!-- Sun icon for light -->
        <svg v-else-if="currentTheme === 'light'" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"
          aria-hidden="true">
          <path
            d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.8 1.42-1.42zM1 13h3v-2H1v2zm10 10h2v-3h-2v3zm9-10v-2h-3v2h3zM6.76 19.16l-1.42 1.42-1.79-1.8 1.41-1.41 1.8 1.79zM13 1h-2v3h2V1zm7.66 3.46l-1.41-1.41-1.8 1.79 1.42 1.42 1.79-1.8zM12 6a6 6 0 100 12 6 6 0 000-12z" />
        </svg>
        <!-- Moon icon for dark -->
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M21.64 13a9 9 0 11-10.63-10.6A9 9 0 0021.64 13z" />
        </svg>
      </button>
      <button class="logout-btn" @click="handleLogout" title="Sign out">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M5 5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h7v-2H5V5zm16 7l-4-4v3H9v2h8v3l4-4z"/>
        </svg>
      </button>
      <div id="err" class="err" v-if="error">{{ error }}</div>
    </header>

    <!-- Main Content -->
    <main id="main" :class="(!selectedEmailId && !composeOpen) ? 'hide-detail' : ''" v-if="connected">
      <!-- Folder List -->
      <FolderList :mailboxes="mailboxes" :current-mailbox-id="currentMailboxId" @compose="toggleCompose"
        @reload="refreshCurrentMailbox" @switch-mailbox="switchMailbox" />

      <!-- Message List -->
      <MessageList :current-mailbox-id="currentMailboxId" :selected-email-id="selectedEmailId" :view-mode="viewMode"
        :visible-messages="visibleMessages" :total-count="totalEmailsCount" @set-view="setView"
        @select-message="selectMessage" @virt-range="onVirtRange" @update:filter-text="filterText = $event" />

      <!-- Detail & Compose -->
      <section class="detail">
        <!-- Compose Panel -->
        <ComposePanel :compose-open="composeOpen" :compose="compose" :identities="identities" :sending="sending"
          :compose-status="composeStatus" :compose-debug="composeDebug" @send="send" @discard="discard"
          @update:compose="Object.assign(compose, $event)" />

        <!-- Message Detail -->
        <MessageDetail :detail="detail" :attachments="attachments" :body-html="bodyHtml" :body-text="bodyText"
          @back-to-list="backToList" @reply="replyToCurrent" @delete="deleteCurrent" @download="download" />
      </section>
    </main>
  </div>
</template>

<style>
/* Global styles are imported from assets/styles.css */
</style>

