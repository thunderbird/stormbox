/**
 * Auth + connection lifecycle. Holds the OIDC handle, the active local
 * account id, and an enum-typed status that the UI maps to its
 * presentation states. No DOM manipulation here — components are
 * responsible for any class toggles or focus management; this store
 * only exposes state and actions.
 */

import { defineStore } from 'pinia';
import type { Oidc } from 'oidc-spa/core';
import { computed, ref } from 'vue';

import { initOidc, getOidc } from '../services/auth';
import { JMAP_SERVER_URL, JMAP_WS_PROXY_URL } from '../defines';
import { AUTH_STATE } from '../constants/states';
import type { AuthState } from '../constants/states';
import { getRepositoryAsync } from '../composables/useRepository';

interface BasicAuth { kind: 'basic'; username: string; password: string }
interface BearerAuth {
  kind: 'bearer';
  token: string;
  issuedAt: number;
  expiresAt: number;
}
interface OidcTokenSnapshot {
  accessToken: string;
  issuedAtTime: number;
  accessTokenExpirationTime: number;
  getServerDateNow: () => number;
}
type ConnectAuth = BasicAuth | BearerAuth;

// oidc-spa renews at 30 seconds remaining; run five seconds inside that window.
const TOKEN_RENEWAL_WINDOW_MS = 25_000;
const TOKEN_RENEWAL_RETRY_MS = 5_000;
const MIN_TOKEN_RENEWAL_DELAY_MS = 1_000;

function bearerAuth(tokens: OidcTokenSnapshot): BearerAuth {
  return {
    kind: 'bearer',
    token: tokens.accessToken,
    issuedAt: tokens.issuedAtTime,
    expiresAt: tokens.accessTokenExpirationTime,
  };
}

function isAtLeastAsFresh(candidate: BearerAuth, current: BearerAuth): boolean {
  if (candidate.issuedAt !== current.issuedAt) {
    return candidate.issuedAt > current.issuedAt;
  }
  return candidate.expiresAt >= current.expiresAt;
}

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
  let unsubscribeFromTokenChanges: (() => void) | null = null;
  let tokenSyncGeneration = 0;
  let tokenUpdateTail: Promise<void> = Promise.resolve();
  let latestBearerAuth: BearerAuth | null = null;
  let tokenSyncAccountId: number | null = null;
  let tokenRenewalTimer: ReturnType<typeof setTimeout> | null = null;
  let tokenUpdateRetryTimer: ReturnType<typeof setTimeout> | null = null;

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
    stopTokenSync();
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
    const generation = startTokenSync(oidc);
    let tokens: Oidc.Tokens;
    try {
      tokens = await oidc.getTokens();
    } catch (err) {
      if (generation === tokenSyncGeneration) stopTokenSync();
      throw err;
    }
    handleOidcTokens(generation, oidc, tokens);
    const initialAuth = latestBearerAuth;
    if (!initialAuth) {
      stopTokenSync();
      error.value = 'OIDC did not provide an access token.';
      status.value = AUTH_STATE.FAILED;
      return false;
    }
    const connected = await _connect(
      initialAuth,
      tokens?.decodedIdToken?.email ?? null,
    );
    if (!connected || generation !== tokenSyncGeneration || accountId.value == null) {
      if (generation === tokenSyncGeneration) stopTokenSync();
      return false;
    }
    tokenSyncAccountId = accountId.value;
    if (latestBearerAuth) {
      try {
        await synchronizeWorkerAuth(generation);
      } catch {
        stopTokenSync();
        accountId.value = null;
        username.value = null;
        clearStorageQuota();
        status.value = AUTH_STATE.FAILED;
        error.value = 'Could not initialize renewable JMAP authentication.';
        return false;
      }
    }
    return true;
  }

  function stopTokenSync(): void {
    tokenSyncGeneration += 1;
    unsubscribeFromTokenChanges?.();
    unsubscribeFromTokenChanges = null;
    if (tokenRenewalTimer != null) clearTimeout(tokenRenewalTimer);
    tokenRenewalTimer = null;
    if (tokenUpdateRetryTimer != null) clearTimeout(tokenUpdateRetryTimer);
    tokenUpdateRetryTimer = null;
    latestBearerAuth = null;
    tokenSyncAccountId = null;
    tokenUpdateTail = Promise.resolve();
  }

  function startTokenSync(oidc: Oidc.LoggedIn): number {
    stopTokenSync();
    const generation = tokenSyncGeneration;
    const subscription = oidc.subscribeToTokensChange((tokens) => {
      handleOidcTokens(generation, oidc, tokens);
    });
    unsubscribeFromTokenChanges = subscription.unsubscribeFromTokensChange;
    return generation;
  }

  function handleOidcTokens(
    generation: number,
    oidc: Oidc.LoggedIn,
    tokens: OidcTokenSnapshot,
  ): void {
    const next = bearerAuth(tokens);
    if (generation !== tokenSyncGeneration) return;
    if (latestBearerAuth && !isAtLeastAsFresh(next, latestBearerAuth)) return;
    const didChange = latestBearerAuth?.token !== next.token;
    latestBearerAuth = next;
    scheduleTokenRenewal(
      generation,
      oidc,
      next.expiresAt - tokens.getServerDateNow(),
    );
    if (didChange && tokenSyncAccountId != null) {
      void queueTokenUpdate(generation, tokenSyncAccountId, next);
    }
  }

  function scheduleTokenRenewal(
    generation: number,
    oidc: Oidc.LoggedIn,
    msUntilExpiration: number,
  ): void {
    if (generation !== tokenSyncGeneration) return;
    if (tokenRenewalTimer != null) clearTimeout(tokenRenewalTimer);
    const delay = Math.max(
      MIN_TOKEN_RENEWAL_DELAY_MS,
      msUntilExpiration - TOKEN_RENEWAL_WINDOW_MS,
    );
    tokenRenewalTimer = setTimeout(() => {
      tokenRenewalTimer = null;
      void refreshOidcTokens(generation, oidc);
    }, delay);
  }

  async function refreshOidcTokens(
    generation: number,
    oidc: Oidc.LoggedIn,
  ): Promise<void> {
    if (generation !== tokenSyncGeneration) return;
    try {
      const tokens = await oidc.getTokens();
      handleOidcTokens(generation, oidc, tokens);
    } catch (err) {
      if (generation !== tokenSyncGeneration) return;
      console.warn('Could not renew OIDC authentication', err);
      if (tokenRenewalTimer != null) clearTimeout(tokenRenewalTimer);
      tokenRenewalTimer = setTimeout(() => {
        tokenRenewalTimer = null;
        void refreshOidcTokens(generation, oidc);
      }, TOKEN_RENEWAL_RETRY_MS);
    }
  }

  async function synchronizeWorkerAuth(generation: number): Promise<void> {
    if (tokenSyncAccountId == null) return;
    const oidc = getOidc();
    if (!oidc?.isUserLoggedIn) {
      throw new Error('Authentication is no longer available.');
    }
    const connectedAccountId = tokenSyncAccountId;
    let tokens: Oidc.Tokens;
    try {
      tokens = await oidc.getTokens();
    } catch {
      scheduleTokenUpdateRetry(generation);
      throw new Error('Authentication could not be refreshed.');
    }
    handleOidcTokens(generation, oidc, tokens);

    while (true) {
      const auth = latestBearerAuth;
      if (!auth
          || generation !== tokenSyncGeneration
          || accountId.value !== connectedAccountId
          || tokenSyncAccountId !== connectedAccountId
          || status.value !== AUTH_STATE.CONNECTED) {
        throw new Error('Authentication changed before it could be synchronized.');
      }
      await queueTokenUpdate(generation, connectedAccountId, auth);
      if (latestBearerAuth === auth) return;
    }
  }

  function scheduleTokenUpdateRetry(generation: number): void {
    if (generation !== tokenSyncGeneration || tokenUpdateRetryTimer != null) return;
    tokenUpdateRetryTimer = setTimeout(() => {
      tokenUpdateRetryTimer = null;
      void synchronizeWorkerAuth(generation).catch(() => {});
    }, TOKEN_RENEWAL_RETRY_MS);
  }

  function queueTokenUpdate(
    generation: number,
    connectedAccountId: number,
    auth: BearerAuth,
  ): Promise<void> {
    const isCurrent = () =>
      generation === tokenSyncGeneration
      && accountId.value === connectedAccountId
      && tokenSyncAccountId === connectedAccountId
      && status.value === AUTH_STATE.CONNECTED;
    const update = tokenUpdateTail
      .catch(() => {})
      .then(async () => {
        if (!isCurrent()) return;
        const repo = await getRepositoryAsync();
        if (!isCurrent()) return;
        const result = await repo.updateSyncAccountAuth(connectedAccountId, {
          token: auth.token,
          issuedAt: auth.issuedAt,
          expiresAt: auth.expiresAt,
        });
        if (result?.updated !== true) {
          throw new Error('The active JMAP worker rejected an OIDC token update.');
        }
        if (tokenUpdateRetryTimer != null) clearTimeout(tokenUpdateRetryTimer);
        tokenUpdateRetryTimer = null;
      });
    tokenUpdateTail = update.catch((err) => {
      console.warn('Could not update JMAP authentication', err);
      scheduleTokenUpdateRetry(generation);
    });
    return update;
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
    stopTokenSync();
    accountId.value = null;
    username.value = null;
    error.value = null;
    status.value = AUTH_STATE.IDLE;
    clearStorageQuota();
  }

  async function logout(): Promise<void> {
    stopTokenSync();
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
