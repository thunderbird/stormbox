<script setup>
import { computed, onMounted, ref } from 'vue';
import { Plus, LogOut } from 'lucide-vue-next';

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

const showLogin = computed(() => authStore.status !== AUTH_STATE.CONNECTED);

const totalUnread = computed(() =>
  mailStore.folders.reduce((sum, f) => sum + (Number(f.unread_emails) || 0), 0),
);

const accountLabel = computed(() =>
  authStore.username || authStore.serverHostname,
);

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
        <button class="sidebar__compose" type="button" @click="startCompose">
          <Plus :size="16" :stroke-width="2" />
          <span>New Message</span>
        </button>
      </header>

      <div class="sidebar__account">
        <span class="sidebar__account-name">{{ accountLabel }}</span>
      </div>

      <FolderTree v-if="space === 'mail'" />
      <p v-else class="sidebar__hint">Switch to Mail to navigate folders.</p>

      <footer class="sidebar__footer">
        <button class="sidebar__signout" type="button" @click="authStore.logout()" :title="`Sign out of ${accountLabel}`">
          <LogOut :size="14" :stroke-width="1.75" />
          <span>Sign out</span>
        </button>
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
  --surface: var(--panel);
  --fg: var(--text);
  --border-soft: color-mix(in srgb, var(--border) 55%, transparent);
  --accent-bg: color-mix(in srgb, var(--accent) 22%, var(--panel2));
  --accent-fg: var(--accent);
  --space-rail-bg: var(--panel2);
  --space-rail-fg: var(--muted);
}

.shell {
  display: grid;
  grid-template-columns: 56px 240px minmax(320px, 1.2fr) minmax(420px, 2fr);
  height: 100vh;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}
.shell > .contacts { grid-column: 3 / span 2; }

.sidebar {
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-right: 1px solid var(--border);
  min-width: 0;
}
.sidebar__header {
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--border-soft);
}
.sidebar__compose {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--accent);
  color: #fff;
  border: 0;
  border-radius: 10px;
  padding: 9px 12px;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  transition: filter 0.12s ease;
}
.sidebar__compose:hover { filter: brightness(1.06); }

.sidebar__account {
  padding: 10px 14px 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 6px;
}
.sidebar__account-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-transform: none;
  letter-spacing: normal;
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.sidebar__hint {
  padding: 16px;
  color: var(--muted);
  font-size: 13px;
}

.sidebar__footer {
  margin-top: auto;
  padding: 8px;
  border-top: 1px solid var(--border-soft);
}
.sidebar__signout {
  width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  background: transparent;
  border: 0;
  border-radius: 8px;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.sidebar__signout:hover {
  background: var(--rowHover);
  color: var(--text);
}
</style>
