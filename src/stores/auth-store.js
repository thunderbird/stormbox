/**
 * Auth + connection lifecycle. Holds the OIDC handle, the active local
 * account id, and an enum-typed status that the UI maps to its
 * presentation states. No DOM manipulation here - components are
 * responsible for any class toggles or focus management; this store
 * only exposes state and actions.
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { initOidc, getOidc } from '../services/auth.js';
import { JMAP_SERVER_URL, JMAP_WS_PROXY_URL } from '../defines.js';
import { AUTH_STATE } from '../constants/states.js';
import { getRepositoryAsync } from '../composables/use-repository.js';

export const useAuthStore = defineStore('auth', () => {
  const status = ref(AUTH_STATE.IDLE);
  const accountId = ref(null);
  const username = ref(null);
  const error = ref(null);

  const serverOrigin = computed(() => {
    try {
      return new URL(JMAP_SERVER_URL).origin;
    } catch {
      return JMAP_SERVER_URL ?? '';
    }
  });

  const serverHostname = computed(() => {
    try {
      return new URL(JMAP_SERVER_URL).hostname;
    } catch {
      return JMAP_SERVER_URL ?? '';
    }
  });

  const isOidcReady = computed(() =>
    status.value === AUTH_STATE.OIDC_READY
    || status.value === AUTH_STATE.CONNECTED,
  );

  const isConnected = computed(() => status.value === AUTH_STATE.CONNECTED);

  /**
   * Run the OIDC bootstrap and, if the user already has a session, kick
   * off a connect right away. Safe to call once on app boot.
   */
  async function initialize() {
    if (status.value !== AUTH_STATE.IDLE) {
      return;
    }
    status.value = AUTH_STATE.OIDC_LOADING;
    try {
      const oidc = await initOidc();
      status.value = AUTH_STATE.OIDC_READY;
      if (oidc?.isUserLoggedIn) {
        await connectViaOidc();
      }
    } catch (err) {
      status.value = AUTH_STATE.FAILED;
      error.value = err?.message ?? String(err);
    }
  }

  /**
   * Connect with username + password (self-host basic auth).
   */
  async function connectWithPassword({ username: u, password }) {
    if (!u || !password) {
      error.value = 'Username and password are required.';
      status.value = AUTH_STATE.FAILED;
      return false;
    }
    return _connect({ kind: 'basic', username: u.trim(), password }, u.trim());
  }

  /**
   * Connect via OIDC. If the user is not yet logged in this redirects
   * them to the IdP; on return, initialize() will pick the session up.
   */
  async function connectViaOidc() {
    const oidc = getOidc();
    if (!oidc) {
      error.value = 'OIDC is not available on this server.';
      status.value = AUTH_STATE.FAILED;
      return false;
    }
    if (!oidc.isUserLoggedIn) {
      await oidc.login();
      return false;
    }
    const tokens = await oidc.getTokens();
    return _connect({ kind: 'bearer', token: tokens.accessToken }, tokens?.decodedIdToken?.email ?? null);
  }

  async function _connect(auth, displayName) {
    status.value = AUTH_STATE.CONNECTING;
    error.value = null;
    try {
      const repo = await getRepositoryAsync();
      const result = await repo.startSyncAccount({
        sessionUrl: `${JMAP_SERVER_URL.replace(/\/$/, '')}/.well-known/jmap`,
        serverOrigin: serverOrigin.value,
        auth,
        wsProxyUrl: JMAP_WS_PROXY_URL || null,
      });
      accountId.value = result.accountId;
      username.value = displayName;
      status.value = AUTH_STATE.CONNECTED;
      return true;
    } catch (err) {
      status.value = AUTH_STATE.FAILED;
      error.value = err?.message ?? String(err);
      return false;
    }
  }

  async function logout() {
    if (accountId.value != null) {
      try {
        const repo = await getRepositoryAsync();
        await repo.stopSyncAccount(accountId.value);
      } catch (err) {
        // We are tearing down; surface the error but do not block.
        console.warn('stopSyncAccount failed during logout', err);
      }
    }
    accountId.value = null;
    username.value = null;
    error.value = null;
    status.value = AUTH_STATE.IDLE;
    const oidc = getOidc();
    if (oidc?.isUserLoggedIn) {
      await oidc.logout({ redirectTo: 'home' });
    }
  }

  return {
    status,
    accountId,
    username,
    error,
    serverOrigin,
    serverHostname,
    isOidcReady,
    isConnected,
    initialize,
    connectWithPassword,
    connectViaOidc,
    logout,
  };
});
