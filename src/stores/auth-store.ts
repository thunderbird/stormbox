/**
 * Auth + connection lifecycle. Holds the OIDC handle, the active local
 * account id, and an enum-typed status that the UI maps to its
 * presentation states. No DOM manipulation here — components are
 * responsible for any class toggles or focus management; this store
 * only exposes state and actions.
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { initOidc, getOidc } from '../services/auth.js';
import { JMAP_SERVER_URL, JMAP_WS_PROXY_URL } from '../defines.js';
import { AUTH_STATE } from '../constants/states';
import type { AuthState } from '../constants/states';
import { getRepositoryAsync } from '../composables/use-repository.js';

interface BasicAuth { kind: 'basic'; username: string; password: string }
interface BearerAuth { kind: 'bearer'; token: string }
type ConnectAuth = BasicAuth | BearerAuth;

function parseServerUrl(): { origin: string; hostname: string } {
  try {
    const url = new URL(JMAP_SERVER_URL);
    return { origin: url.origin, hostname: url.hostname };
  } catch {
    return { origin: JMAP_SERVER_URL ?? '', hostname: JMAP_SERVER_URL ?? '' };
  }
}

export const useAuthStore = defineStore('auth', () => {
  const status = ref<AuthState>(AUTH_STATE.IDLE);
  const accountId = ref<number | null>(null);
  const username = ref<string | null>(null);
  const error = ref<string | null>(null);

  const serverOrigin = computed(() => parseServerUrl().origin);
  const serverHostname = computed(() => parseServerUrl().hostname);

  const isOidcReady = computed(() =>
    status.value === AUTH_STATE.OIDC_READY
    || status.value === AUTH_STATE.CONNECTED,
  );

  const isConnected = computed(() => status.value === AUTH_STATE.CONNECTED);

  const quotaUsedBytes = ref<number | null>(null);
  const quotaHardLimitBytes = ref<number | null>(null);

  const hasStorageQuota = computed(() =>
    quotaHardLimitBytes.value != null && quotaHardLimitBytes.value > 0,
  );

  const storagePercentUsed = computed(() => {
    if (!hasStorageQuota.value || quotaUsedBytes.value == null) {
      return 0;
    }
    const limit = quotaHardLimitBytes.value!;
    return limit > 0
      ? Math.min(100, Math.round((quotaUsedBytes.value / limit) * 100))
      : 0;
  });

  const storageProgressWidth = computed(() => `${storagePercentUsed.value}%`);

  function clearStorageQuota() {
    quotaUsedBytes.value = null;
    quotaHardLimitBytes.value = null;
  }

  async function refreshStorageQuota() {
    if (accountId.value == null) {
      clearStorageQuota();
      return;
    }
    const repo = await getRepositoryAsync();
    const snapshot = await repo.getStorageQuota(accountId.value);
    quotaUsedBytes.value = snapshot?.usedBytes ?? null;
    quotaHardLimitBytes.value = snapshot?.hardLimitBytes ?? null;
  }

  /**
   * Run the OIDC bootstrap and, if the user already has a session, kick
   * off a connect right away. Safe to call once on app boot.
   */
  async function initialize(): Promise<void> {
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
    } catch (err: any) {
      status.value = AUTH_STATE.FAILED;
      error.value = err?.message ?? String(err);
    }
  }

  /**
   * Connect with username + password (self-host basic auth).
   */
  async function connectWithPassword(
    { username: u, password }: { username: string; password: string },
  ): Promise<boolean> {
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
  async function connectViaOidc(): Promise<boolean> {
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
    return _connect(
      { kind: 'bearer', token: tokens.accessToken },
      tokens?.decodedIdToken?.email ?? null,
    );
  }

  async function _connect(auth: ConnectAuth, displayName: string | null): Promise<boolean> {
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
      refreshStorageQuota().catch(() => {});
      return true;
    } catch (err: any) {
      status.value = AUTH_STATE.FAILED;
      error.value = err?.message ?? String(err);
      return false;
    }
  }

  /**
   * Drop every piece of session-scoped auth state without touching
   * the OIDC session. Used by logout after stopSyncAccount, and
   * exposed as $reset for callers that want the local clear without
   * the IdP redirect.
   */
  function $reset(): void {
    accountId.value = null;
    username.value = null;
    error.value = null;
    status.value = AUTH_STATE.IDLE;
    clearStorageQuota();
  }

  async function logout(): Promise<void> {
    if (accountId.value != null) {
      try {
        const repo = await getRepositoryAsync();
        await repo.stopSyncAccount(accountId.value);
      } catch (err) {
        // We are tearing down; surface the error but do not block.
        console.warn('stopSyncAccount failed during logout', err);
      }
    }
    $reset();
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
    quotaUsedBytes,
    quotaHardLimitBytes,
    hasStorageQuota,
    storagePercentUsed,
    storageProgressWidth,
    refreshStorageQuota,
    initialize,
    connectWithPassword,
    connectViaOidc,
    $reset,
    logout,
  };
});
