<script setup lang="ts">
import { computed, ref } from 'vue';
import { Loader2 } from '@lucide/vue';

import { useAuthStore } from '../stores/auth-store.js';
import { AUTH_STATE } from '../constants/states.js';
import ThundermailLogo from './ThundermailLogo.vue';

const authStore = useAuthStore();

const showPasswordForm = ref(false);
const username = ref('');
const password = ref('');

const isBusy = computed(() =>
  authStore.status === AUTH_STATE.OIDC_LOADING
  || authStore.status === AUTH_STATE.CONNECTING,
);

const isFailed = computed(() => authStore.status === AUTH_STATE.FAILED);

const statusLabel = computed(() => {
  switch (authStore.status) {
    case AUTH_STATE.OIDC_LOADING: return 'Initialising…';
    case AUTH_STATE.CONNECTING:   return 'Connecting…';
    case AUTH_STATE.FAILED:       return 'Failed.';
    default:                      return 'Not connected.';
  }
});

async function signInWithThunderbird() {
  await authStore.connectViaOidc();
}

async function submitPassword(event) {
  event.preventDefault();
  await authStore.connectWithPassword({
    username: username.value,
    password: password.value,
  });
}

function togglePassword() {
  showPasswordForm.value = !showPasswordForm.value;
}
</script>

<template>
  <div class="login-gate">
    <div class="login-stack">
      <p class="login-warning" role="note">
        This is an Early Alpha and subject to (very) frequent change. Use at your own risk!
      </p>

      <div class="login-card">
        <ThundermailLogo :size="56" class="login-card__logo" />
        <h1 class="login-card__title">Thundermail</h1>
        <p class="login-card__subtitle">Sign in with your Thunderbird account.</p>

        <div v-if="isBusy" class="login-card__busy" role="status" aria-live="polite">
          <Loader2 :size="32" :stroke-width="2" class="login-card__spinner" />
          <p class="login-card__status">{{ statusLabel }}</p>
        </div>

        <template v-else>
          <button
            class="login-card__primary"
            type="button"
            :disabled="!authStore.isOidcReady"
            @click="signInWithThunderbird"
          >
            Sign in with Thunderbird
          </button>

          <button
            v-if="!showPasswordForm"
            class="login-card__link"
            type="button"
            @click="togglePassword"
          >
            Use app password instead
          </button>

          <form v-else class="login-card__password" @submit="submitPassword">
            <label>
              <span>Username</span>
              <input
                v-model="username"
                type="text"
                autocomplete="username"
                required
              />
            </label>
            <label>
              <span>App password</span>
              <input
                v-model="password"
                type="password"
                autocomplete="current-password"
                required
              />
            </label>
            <div class="login-card__password-actions">
              <button class="login-card__secondary" type="submit">
                Sign in
              </button>
              <button
                class="login-card__link"
                type="button"
                @click="togglePassword"
              >
                Back
              </button>
            </div>
          </form>

          <p v-if="isFailed" class="login-card__status">{{ statusLabel }}</p>
          <p v-if="authStore.error" class="login-card__error">{{ authStore.error }}</p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-gate {
  display: grid;
  place-items: center;
  min-height: var(--app-viewport-height);
  background: var(--bg);
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

.login-warning {
  box-sizing: border-box;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid rgba(255, 193, 7, 0.38);
  border-radius: 10px;
  background: rgba(255, 193, 7, 0.1);
  color: #ffd166;
  font-size: 12px;
  line-height: 1.4;
  text-align: center;
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

.login-card__primary {
  appearance: none;
  background: var(--accent);
  color: #fff;
  border: 0;
  border-radius: 10px;
  padding: 11px 14px;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.3;
  cursor: pointer;
  transition: filter 0.12s ease;
}
.login-card__primary:hover:not(:disabled) { filter: brightness(1.05); }
.login-card__primary:disabled { opacity: 0.6; cursor: not-allowed; }

.login-card__secondary {
  appearance: none;
  background: transparent;
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 14px;
  font-size: 13px;
  line-height: 1.3;
  cursor: pointer;
}
.login-card__secondary:hover:not(:disabled) { background: var(--panel2); }

.login-card__link {
  appearance: none;
  background: transparent;
  color: var(--muted);
  border: 0;
  padding: 6px 0 0;
  font-size: 12px;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  align-self: center;
}
.login-card__link:hover:not(:disabled) { color: var(--text); }

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
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-size: 14px;
  outline: none;
}
.login-card__password input:focus { border-color: var(--accent); }
.login-card__password-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

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
  color: #ff6b6b;
  font-size: 12px;
  white-space: pre-wrap;
}

@media (max-width: 360px) {
  .login-card__password-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .login-card__password-actions .login-card__link {
    align-self: center;
  }
}
</style>
