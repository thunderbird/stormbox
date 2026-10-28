import { t, LocalizedError, sourceText } from '../i18n/messages';
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
import { currentHref, reloadLocation, replaceLocation } from '../services/navigation';
import { JMAP_SERVER_URL, JMAP_WS_PROXY_URL, STAFF_APP_URL } from '../defines';
import { AUTH_STATE } from '../constants/states';
import type { AuthState } from '../constants/states';
import { isStaffEmail } from '../constants/staff';
import { staffRedirectUrl } from '../utils/staff-redirect';
import { getRepositoryAsync } from '../composables/useRepository';
import { DatabaseUnavailableError } from '../db/availability';

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
const OIDC_REDIRECT_PENDING_KEY = 'stormbox.oidcRedirectPending';

function appPasswordRequested(): boolean {
  if (new URLSearchParams(globalThis.location?.search ?? '').has('app-password')) return true;
  try {
    return globalThis.localStorage?.getItem('stormbox.appPassword') === '1';
  } catch {
    return false;
  }
}

function oidcRedirectPending(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(OIDC_REDIRECT_PENDING_KEY) === '1';
  } catch {
    return false;
  }
}

function setOidcRedirectPending(pending: boolean): void {
  try {
    if (pending) globalThis.sessionStorage?.setItem(OIDC_REDIRECT_PENDING_KEY, '1');
    else globalThis.sessionStorage?.removeItem(OIDC_REDIRECT_PENDING_KEY);
  } catch {
    // Storage can be unavailable in a restricted browser session.
  }
}

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

function stringClaim(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
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
  const appPasswordMode = ref(appPasswordRequested());
  const accountId = ref<number | null>(null);
  const username = ref<string | null>(null);
  /** OIDC ID-token `email` claim; null for password sign-in. */
  const email = ref<string | null>(null);
  /** OIDC ID-token `recovery_email` claim; null when unavailable. */
  const recoveryEmail = ref<string | null>(null);
  const error = ref<string | null>(null);
  const databaseUnavailable = ref(false);

  /**
   * Global staff flag: gates staff-only UI. The same claim decides the
   * sign-in redirect to STAFF_APP_URL in connectViaOidc.
   */
  const isStaff = computed(() => isStaffEmail(recoveryEmail.value));

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
   * Select the explicit password flow or connect through OIDC once on boot.
   */
  async function initialize(): Promise<void> {
    if (status.value !== AUTH_STATE.IDLE) {
      return;
    }
    if (appPasswordMode.value) {
      setOidcRedirectPending(false);
      status.value = AUTH_STATE.OIDC_READY;
      return;
    }
    status.value = AUTH_STATE.OIDC_LOADING;
    let oidc: Awaited<ReturnType<typeof initOidc>>;
    try {
      oidc = await initOidc();
    } catch (err) {
      reportOidcInitializationError(err);
      return;
    }
    if (databaseUnavailable.value) return;
    if (oidc && !oidc.isUserLoggedIn && oidc.initializationError) {
      reportOidcInitializationError(oidc.initializationError);
      return;
    }
    if (!oidc?.isUserLoggedIn && oidcRedirectPending()) {
      status.value = AUTH_STATE.FAILED;
      error.value = t('authStore.signInDidNotCompleteTryAgainToReturn');
      return;
    }
    status.value = AUTH_STATE.OIDC_READY;
    await connectViaOidc();
  }

  function reportOidcInitializationError(err: unknown): void {
    if (databaseUnavailable.value) return;
    console.error('Could not initialize OIDC sign-in', err);
    const serviceUnavailable = typeof err === 'object' && err != null
      && 'isAuthServerLikelyDown' in err && err.isAuthServerLikelyDown;
    status.value = AUTH_STATE.FAILED;
    error.value = serviceUnavailable
      ? t('authStore.theSignInServiceIsUnavailablePleaseTryAgain')
      : t('authStore.signInCouldNotBeInitializedPleaseTryAgain');
  }

  /**
   * Connect with username + password (self-host basic auth).
   */
  async function connectWithPassword(
    { username: u, password }: { username: string; password: string },
  ): Promise<boolean> {
    if (databaseUnavailable.value) return false;
    if (!u || !password) {
      error.value = t('authStore.usernameAndPasswordAreRequired');
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
    if (databaseUnavailable.value || status.value === AUTH_STATE.CONNECTING) return false;
    status.value = AUTH_STATE.CONNECTING;
    error.value = null;
    try {
      return await _connectViaOidc();
    } catch (err: any) {
      stopTokenSync();
      if (databaseUnavailable.value || reportDatabaseError(err)) return false;
      status.value = AUTH_STATE.FAILED;
      error.value = err?.message ?? String(err);
      return false;
    }
  }

  async function _connectViaOidc(): Promise<boolean> {
    const oidc = getOidc();
    if (!oidc) {
      error.value = t('authStore.oIDCIsNotAvailableOnThisServer');
      status.value = AUTH_STATE.FAILED;
      return false;
    }
    if (!oidc.isUserLoggedIn) {
      if (oidc.initializationError) {
        reportOidcInitializationError(oidc.initializationError);
        return false;
      }
      setOidcRedirectPending(true);
      await oidc.login();
      throw new Error(t('authStore.signInDidNotCompleteTryAgainToReturn'));
    }
    setOidcRedirectPending(false);
    const generation = startTokenSync(oidc);
    let tokens: Oidc.Tokens;
    try {
      tokens = await oidc.getTokens();
    } catch (err) {
      if (generation === tokenSyncGeneration) stopTokenSync();
      throw err;
    }
    if (databaseUnavailable.value) return false;
    handleOidcTokens(generation, oidc, tokens);
    const initialAuth = latestBearerAuth;
    if (!initialAuth) {
      stopTokenSync();
      error.value = t('authStore.oIDCDidNotProvideAnAccessToken');
      status.value = AUTH_STATE.FAILED;
      return false;
    }
    const emailClaim = stringClaim(tokens?.decodedIdToken?.email);
    const recoveryEmailClaim = stringClaim(tokens?.decodedIdToken?.recovery_email);
    // Staff leave for the staff app before any local account exists on
    // this origin. The OIDC session here is left alone: the destination
    // signs in through the same Keycloak SSO cookie.
    const staffRedirect = isStaffEmail(recoveryEmailClaim)
      && !recoveryEmailClaim?.toLowerCase().includes('mzlatest')
      ? staffRedirectUrl(STAFF_APP_URL, currentHref())
      : null;
    if (staffRedirect) {
      stopTokenSync();
      status.value = AUTH_STATE.CONNECTING;
      replaceLocation(staffRedirect);
      return false;
    }
    const connected = await _connect(
      initialAuth,
      emailClaim,
      emailClaim,
      recoveryEmailClaim,
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
        email.value = null;
        recoveryEmail.value = null;
        clearStorageQuota();
        if (databaseUnavailable.value) return false;
        status.value = AUTH_STATE.FAILED;
        error.value = t('authStore.couldNotInitializeRenewableJMAPAuthentication');
        return false;
      }
    }
    return true;
  }

  function cancelOidcLogin(): void {
    if (status.value !== AUTH_STATE.CONNECTING || getOidc()?.isUserLoggedIn) return;
    status.value = AUTH_STATE.FAILED;
    error.value = t('authStore.signInDidNotCompleteTryAgainToReturn');
  }

  async function retryOidc(): Promise<void> {
    if (status.value !== AUTH_STATE.FAILED) return;
    setOidcRedirectPending(false);
    const oidc = getOidc();
    if (databaseUnavailable.value || !oidc || (!oidc.isUserLoggedIn && oidc.initializationError)) {
      reloadLocation();
      return;
    }
    await connectViaOidc();
  }

  function reportDatabaseError(cause: unknown): boolean {
    if (!(cause instanceof DatabaseUnavailableError)) return false;
    stopTokenSync();
    databaseUnavailable.value = true;
    status.value = AUTH_STATE.FAILED;
    error.value = cause.message;
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
      throw new LocalizedError('authStore.authenticationIsNoLongerAvailable');
    }
    const connectedAccountId = tokenSyncAccountId;
    let tokens: Oidc.Tokens;
    try {
      tokens = await oidc.getTokens();
    } catch {
      scheduleTokenUpdateRetry(generation);
      throw new LocalizedError('authStore.authenticationCouldNotBeRefreshed');
    }
    handleOidcTokens(generation, oidc, tokens);

    while (true) {
      const auth = latestBearerAuth;
      if (!auth
          || generation !== tokenSyncGeneration
          || accountId.value !== connectedAccountId
          || tokenSyncAccountId !== connectedAccountId
          || status.value !== AUTH_STATE.CONNECTED) {
        throw new LocalizedError('authStore.authenticationChangedBeforeItCouldBeSynchronized');
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
          throw new LocalizedError('authStore.theActiveJMAPWorkerRejectedAnOIDCTokenUpdate');
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

  async function _connect(
    auth: ConnectAuth,
    displayName: string | null,
    emailClaim: string | null = null,
    recoveryEmailClaim: string | null = null,
  ): Promise<boolean> {
    if (databaseUnavailable.value) return false;
    status.value = AUTH_STATE.CONNECTING;
    error.value = null;
    try {
      const repo = await getRepositoryAsync();
      if (databaseUnavailable.value) return false;
      const result = await repo.startSyncAccount({
        sessionUrl: `${JMAP_SERVER_URL.replace(/\/$/, '')}/.well-known/jmap`,
        serverOrigin: serverOrigin.value,
        auth,
        wsProxyUrl: JMAP_WS_PROXY_URL || null,
      });
      if (databaseUnavailable.value) return false;
      accountId.value = result.accountId;
      username.value = displayName;
      email.value = emailClaim;
      recoveryEmail.value = recoveryEmailClaim;
      status.value = AUTH_STATE.CONNECTED;
      refreshStorageQuota().catch(() => {});
      return true;
    } catch (err: any) {
      if (databaseUnavailable.value || reportDatabaseError(err)) return false;
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
    email.value = null;
    recoveryEmail.value = null;
    error.value = null;
    databaseUnavailable.value = false;
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
    appPasswordMode,
    accountId,
    username,
    email,
    recoveryEmail,
    isStaff,
    error,
    databaseUnavailable,
    reportDatabaseError,
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
    cancelOidcLogin,
    retryOidc,
    $reset,
    logout,
  };
});
