<script setup lang="ts">
import { computed, ref } from 'vue';
import { Loader2 } from '@lucide/vue';
import { NoticeWarningIcon } from '@thunderbirdops/services-ui';
import AppButton from './AppButton.vue';

import { useAuthStore } from '../stores/auth-store';
import { AUTH_STATE } from '../constants/states';
import ThundermailLogo from './ThundermailLogo.vue';

const authStore = useAuthStore();

const showPasswordForm = ref(false);
const username = ref('');
const password = ref('');

// App-password sign-in stays available but is no longer surfaced by
// default. It opts in via ?app-password in the URL or a persisted
// localStorage flag, so power users / non-OIDC setups can still reach it.
const appPasswordEnabled = computed(() => {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).has('app-password')) return true;
    return window.localStorage?.getItem('stormbox.appPassword') === '1';
  } catch {
    return false;
  }
});

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
        <NoticeWarningIcon class="login-warning__icon" aria-hidden="true" />
        <span>This is an Early Alpha and subject to (very) frequent change. Use at your own risk!</span>
      </p>

      <div class="login-card">
        <ThundermailLogo :size="56" class="login-card__logo" />
        <h1 class="login-card__title">Thundermail</h1>
        <p class="login-card__subtitle">Sign in with your Thundermail account.</p>

        <div v-if="isBusy" class="login-card__busy" role="status" aria-live="polite">
          <Loader2 :size="32" :stroke-width="2" class="login-card__spinner" />
          <p class="login-card__status">{{ statusLabel }}</p>
        </div>

        <template v-else>
          <AppButton
            size="default"
            class="login-card__signin"
            :disabled="!authStore.isOidcReady"
            @click="signInWithThunderbird"
          >
            Sign In
          </AppButton>

          <!-- App-password sign-in is hidden by default now that OIDC is
               the norm, but the flow is fully intact. Reveal the entry
               point with ?app-password in the URL or by setting
               localStorage['stormbox.appPassword']='1'. -->
          <button
            v-if="!showPasswordForm && appPasswordEnabled"
            class="login-card__link"
            type="button"
            @click="togglePassword"
          >
            Use app password instead
          </button>

          <form v-if="showPasswordForm" class="login-card__password" @submit="submitPassword">
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
              <AppButton form-action="submit">
                Sign in
              </AppButton>
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

/* Sign in uses our AppButton at services-ui's default height, centered
   with a comfortable min-width rather than stretched across the card. */
.login-card__signin {
  align-self: center;
  min-width: 160px;
}

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
