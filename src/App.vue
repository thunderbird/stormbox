<script setup>
import { computed, onMounted, ref } from 'vue';

import { useAuthStore } from './stores/auth-store.js';
import { useMailStore } from './stores/mail-store.js';
import { useContactsStore } from './stores/contacts-store.js';
import { useComposeStore } from './stores/compose-store.js';
import { AUTH_STATE } from './constants/states.js';

import AppSpaces from './components/AppSpaces.vue';
import LoginGate from './components/LoginGate.vue';
import FolderTree from './components/FolderTree.vue';
import MessageList from './components/MessageList.vue';
import MessageView from './components/MessageView.vue';
import ComposeDialog from './components/ComposeDialog.vue';
import ContactsView from './components/ContactsView.vue';

const authStore = useAuthStore();
const mailStore = useMailStore();
const contactsStore = useContactsStore();
const composeStore = useComposeStore();

const space = ref('mail');

const showLogin = computed(() =>
  authStore.status !== AUTH_STATE.CONNECTED,
);

const totalUnread = computed(() => {
  return mailStore.folders.reduce((sum, f) => sum + (Number(f.unread_emails) || 0), 0);
});

onMounted(async () => {
  await authStore.initialize();
  await mailStore.attach();
  await contactsStore.attach();
  await composeStore.attach();
});

function startCompose() {
  composeStore.open();
}
</script>

<template>
  <LoginGate v-if="showLogin" />
  <div v-else class="shell">
    <AppSpaces :active="space" :unread-count="totalUnread" @change="space = $event" />

    <aside class="sidebar">
      <header class="sidebar__header">
        <button class="primary" type="button" @click="startCompose">+ New Message</button>
      </header>
      <FolderTree v-if="space === 'mail'" />
      <p v-else class="sidebar__hint">Switch to Mail to navigate folders.</p>
      <footer class="sidebar__footer">
        <span class="sidebar__user">{{ authStore.username || authStore.serverHostname }}</span>
        <button class="link" type="button" @click="authStore.logout()">Sign out</button>
      </footer>
    </aside>

    <template v-if="space === 'mail'">
      <MessageList />
      <MessageView />
    </template>
    <ContactsView v-else-if="space === 'contacts'" />

    <ComposeDialog />
  </div>
</template>

<style>
:root {
  --bg: #f5f6f9;
  --surface: #ffffff;
  --fg: #161821;
  --muted: #6b7388;
  --border: #e3e6ee;
  --border-soft: #eef0f5;
  --accent-bg: #e2e9fb;
  --accent-fg: #1d4ed8;
  --space-rail-bg: #20283d;
  --space-rail-fg: #cfd6e8;
}
html, body, #app { height: 100%; margin: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: var(--fg); background: var(--bg); }

.shell {
  display: grid;
  grid-template-columns: 56px 240px 1.2fr 2fr;
  height: 100vh;
}
.shell > .contacts { grid-column: 3 / span 2; }

.sidebar {
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-right: 1px solid var(--border);
  min-width: 0;
}
.sidebar__header { padding: 12px; border-bottom: 1px solid var(--border-soft); }
.sidebar__header .primary {
  width: 100%;
  background: #2563eb;
  color: #fff;
  border: 0;
  border-radius: 8px;
  padding: 8px 12px;
  cursor: pointer;
  font: inherit;
}
.sidebar__hint { padding: 16px; color: var(--muted); font-size: 13px; }
.sidebar__footer {
  margin-top: auto;
  padding: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  border-top: 1px solid var(--border-soft);
  color: var(--muted);
}
.sidebar__footer .link {
  background: none;
  border: 0;
  color: #2563eb;
  cursor: pointer;
  font: inherit;
}
</style>
