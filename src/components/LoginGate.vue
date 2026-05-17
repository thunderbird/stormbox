<script setup>
import { computed, ref } from 'vue';

import { useAuthStore } from '../stores/auth-store.js';
import { AUTH_STATE } from '../constants/states.js';

const authStore = useAuthStore();

const username = ref('');
const password = ref('');

const isBusy = computed(() =>
  authStore.status === AUTH_STATE.OIDC_LOADING
  || authStore.status === AUTH_STATE.CONNECTING,
);

const statusLabel = computed(() => {
  switch (authStore.status) {
    case AUTH_STATE.OIDC_LOADING: return 'Initialising authentication…';
    case AUTH_STATE.CONNECTING: return 'Connecting…';
    case AUTH_STATE.FAILED: return 'Failed.';
    case AUTH_STATE.OIDC_READY:
    case AUTH_STATE.IDLE:
    default:
      return 'Sign in to your mail server.';
  }
});

async function submit(event) {
  event.preventDefault();
  await authStore.connectWithPassword({ username: username.value, password: password.value });
}

async function oauth() {
  await authStore.connectViaOidc();
}
</script>

<template>
  <div class="login-gate">
    <form class="login-card" @submit="submit">
      <h1>Stormbox</h1>
      <p class="login-server">{{ authStore.serverHostname }}</p>
      <p class="login-status">{{ statusLabel }}</p>

      <label>
        <span>Username</span>
        <input
          v-model="username"
          type="text"
          autocomplete="username"
          :disabled="isBusy"
          required
        />
      </label>
      <label>
        <span>Password</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          :disabled="isBusy"
          required
        />
      </label>

      <button class="primary" type="submit" :disabled="isBusy">Sign in</button>
      <button class="secondary" type="button" :disabled="isBusy || !authStore.isOidcReady" @click="oauth">
        Sign in with OIDC
      </button>

      <p v-if="authStore.error" class="login-error">{{ authStore.error }}</p>
    </form>
  </div>
</template>

<style scoped>
.login-gate {
  display: grid;
  place-items: center;
  min-height: 100vh;
  background: var(--login-bg, #f5f6f9);
}
.login-card {
  width: 360px;
  padding: 24px;
  background: var(--surface, #fff);
  border-radius: 12px;
  box-shadow: 0 8px 28px rgba(13, 22, 42, 0.08);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.login-card h1 {
  margin: 0;
  font-size: 22px;
}
.login-server {
  margin: 0;
  font-size: 12px;
  color: var(--muted, #6b7388);
}
.login-status {
  margin: 0 0 4px;
  color: var(--muted, #6b7388);
  font-size: 13px;
}
.login-card label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.login-card input {
  padding: 8px 10px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
  font-size: 14px;
  background: #fff;
  color: var(--fg, #111);
}
.login-card button {
  padding: 9px 12px;
  border-radius: 8px;
  border: 0;
  cursor: pointer;
  font-weight: 500;
}
.primary { background: #2563eb; color: #fff; }
.secondary { background: transparent; color: #2563eb; border: 1px solid #c9d4ee; }
.login-error {
  margin: 0;
  color: #b3261e;
  font-size: 13px;
}
</style>
