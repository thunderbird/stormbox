<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { Loader2 } from '@lucide/vue';
import { NoticeWarningIcon } from '@thunderbirdops/services-ui';
import AppButton from './AppButton.vue';

import { useAuthStore } from '../stores/auth-store';
import { AUTH_STATE } from '../constants/states';
import { hasAutoLoginFlag, withoutAutoLoginFlag } from '../utils/staff-redirect';
import ThundermailLogo from './ThundermailLogo.vue';

const authStore = useAuthStore();
const username = ref('');
const password = ref('');
const isOnline = useOnline();

if (typeof window !== 'undefined' && hasAutoLoginFlag(window.location.search)) {
  window.history.replaceState(window.history.state, '', withoutAutoLoginFlag(window.location.href));
}

const isBusy = computed(() =>
  authStore.status === AUTH_STATE.OIDC_LOADING
  || authStore.status === AUTH_STATE.CONNECTING,
);
const isFailed = computed(() => authStore.status === AUTH_STATE.FAILED);
const statusLabel = computed(() => {
  if (!isOnline.value && !isFailed.value) return 'You are offline. Waiting for a connection…';
  switch (authStore.status) {
    case AUTH_STATE.OIDC_LOADING: return 'Initialising…';
    case AUTH_STATE.CONNECTING: return 'Connecting…';
    case AUTH_STATE.FAILED: return 'Could not connect.';
    default: return 'Connecting to your account…';
  }
});

async function submitPassword(event: SubmitEvent) {
  event.preventDefault();
  await authStore.connectWithPassword({ username: username.value, password: password.value });
}

function onPageShow(event: PageTransitionEvent) {
  if (event.persisted && !authStore.appPasswordMode) authStore.cancelOidcLogin();
}

onMounted(() => window.addEventListener('pageshow', onPageShow));
onBeforeUnmount(() => window.removeEventListener('pageshow', onPageShow));
</script>

<template>
  <div class="login-gate">
    <div v-if="authStore.appPasswordMode" class="login-stack">
      <p class="login-warning" role="note">
        <NoticeWarningIcon class="login-warning__icon" aria-hidden="true" />
        <span>Webmail is in early alpha and subject to frequent changes and instability</span>
      </p>

      <div class="login-card">
        <ThundermailLogo :size="56" class="login-card__logo" />
        <h1 class="login-card__title">Thundermail</h1>
        <p class="login-card__subtitle">Sign in with your app password.</p>

        <form class="login-card__password" @submit="submitPassword">
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
            <span>App password</span>
            <input
              v-model="password"
              type="password"
              autocomplete="current-password"
              :disabled="isBusy"
              required
            />
          </label>
          <AppButton form-action="submit" :disabled="isBusy">
            Sign in
          </AppButton>
        </form>
        <div v-if="isBusy || isFailed" class="login-card__busy" role="status" aria-live="polite">
          <Loader2 v-if="isBusy" :size="32" :stroke-width="2" class="login-card__spinner" aria-hidden="true" />
          <p class="login-card__status">{{ statusLabel }}</p>
        </div>
        <p v-if="authStore.error" class="login-card__error" role="alert">{{ authStore.error }}</p>
      </div>
    </div>
    <div v-else class="login-progress">
      <div class="login-card__busy" role="status" aria-live="polite">
        <Loader2 v-if="!isFailed" :size="32" :stroke-width="2" class="login-card__spinner" aria-hidden="true" />
        <p class="login-card__status">{{ statusLabel }}</p>
      </div>
      <p v-if="authStore.error" class="login-card__error" role="alert">{{ authStore.error }}</p>
      <AppButton v-if="isFailed" class="login-card__retry" @click="authStore.retryOidc">
        Try again
      </AppButton>
    </div>
  </div>
</template>

<style scoped>
.login-gate {
  display: grid;
  place-items: center;
  min-height: var(--app-viewport-height);
  background: var(--panel);
  color: var(--text);
  padding: clamp(16px, 6vw, 24px);
}

.login-stack {
  box-sizing: border-box;
  width: 100%;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.login-progress {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  max-width: 360px;
}

/* Our own warning banner; only the warning glyph comes from services-ui.
   Colours come from theme-aware --warn-* tokens (see assets/styles.css);
   both themes meet WCAG AA (>=4.5:1) for this body text. */
.login-warning {
  box-sizing: border-box;
  /* Size to the copy so it stays on one line, floating wider than the
     360px card; clamps to the viewport (minus the gate padding) and wraps
     only on very narrow screens. */
  width: max-content;
  max-width: calc(100vw - 48px);
  align-self: center;
  margin: 0;
  display: flex;
  /* Anchor the icon to the first text line (not the box middle) so the
     banner reads correctly when the copy wraps on narrow screens. */
  align-items: flex-start;
  text-align: left;
  gap: 10px;
  padding: 10px 16px;
  border: 1px solid var(--warn-border);
  border-radius: 10px;
  background: var(--warn-bg);
  color: var(--warn-fg);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
}
.login-warning__icon {
  flex: none;
  width: 18px;
  height: 18px;
  /* The 18px icon box matches the first line box (13px x 1.4 ≈ 18.2px), so
     flex-start alignment centers it on the first text line by itself. */
}

.login-card {
  box-sizing: border-box;
  width: 100%;
  padding: clamp(24px, 8vw, 32px) clamp(18px, 7vw, 28px) 24px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}

/* A black shadow cannot read on the dark page; cast a grey one instead. */
html.dark .login-card {
  box-shadow: 0 12px 40px rgba(255, 255, 255, 0.1);
}

.login-card__logo {
  align-self: center;
  margin-bottom: 4px;
}

.login-card__title {
  margin: 0;
  text-align: center;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: 0.1px;
}

.login-card__subtitle {
  margin: 0;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}

.login-card__password {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.login-card__password label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.login-card__password input {
  padding: 9px 11px;
  background: var(--panel2);
  border: 1px solid var(--control-border);
  border-radius: 8px;
  color: var(--text);
  font-size: 14px;
  outline: none;
}
.login-card__password input:focus { border-color: var(--accent); }
.login-card__busy {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 18px 0 6px;
}
.login-card__spinner {
  color: var(--accent);
  animation: login-spin 1s linear infinite;
}
@keyframes login-spin {
  to { transform: rotate(360deg); }
}

.login-card__status {
  margin: 6px 0 0;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
}

.login-card__error {
  margin: 6px 0 0;
  text-align: center;
  color: var(--error-fg);
  font-size: 12px;
  white-space: pre-wrap;
}

</style>
